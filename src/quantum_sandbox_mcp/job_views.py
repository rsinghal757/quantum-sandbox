from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
import json
from math import log10
from pathlib import Path
from typing import Any

import numpy as np
from qiskit import transpile
from qiskit.circuit import QuantumCircuit
from qiskit.quantum_info import Statevector, partial_trace
from qiskit_aer import AerSimulator

from .circuit_utils import circuit_from_qasm, circuit_summary


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _duration_ms(created_at: Any, updated_at: Any) -> int | None:
    start = _parse_timestamp(created_at)
    end = _parse_timestamp(updated_at)
    if start is None or end is None:
        return None
    return max(int((end - start).total_seconds() * 1000), 0)


def _json_safe(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, Mapping):
        return {str(key): _json_safe(raw) for key, raw in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return str(value)


def _normalize_param(value: Any) -> float | str:
    try:
        return float(value)
    except (TypeError, ValueError):
        return str(value)


def _operation_payload(circuit: QuantumCircuit) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for instruction in circuit.data:
        payload.append(
            {
                "name": instruction.operation.name,
                "qubits": [circuit.find_bit(bit).index for bit in instruction.qubits],
                "clbits": [circuit.find_bit(bit).index for bit in instruction.clbits],
                "params": [_normalize_param(param) for param in instruction.operation.params],
            }
        )
    return payload


def _layer_operations(operations: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    layers: list[list[dict[str, Any]]] = []
    occupied_wires: list[set[str]] = []

    for operation in operations:
        wires = {f"q{index}" for index in operation["qubits"]}
        wires.update(f"c{index}" for index in operation["clbits"])

        placed = False
        for layer_index, taken in enumerate(occupied_wires):
            if wires.isdisjoint(taken):
                layers[layer_index].append(operation)
                taken.update(wires)
                placed = True
                break

        if not placed:
            layers.append([operation])
            occupied_wires.append(set(wires))

    return layers


def _structured_gates(operations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    gates: list[dict[str, Any]] = []
    for operation in operations:
        gate: dict[str, Any] = {
            "gate": operation["name"],
            "qubits": operation["qubits"],
        }
        if operation["params"]:
            gate["params"] = operation["params"]
        if operation["clbits"]:
            gate["clbits"] = operation["clbits"]
        gates.append(gate)
    return gates


def _python_literal(value: Any) -> str:
    if isinstance(value, str):
        return repr(value)
    if isinstance(value, float):
        rendered = f"{value:.8f}".rstrip("0").rstrip(".")
        return rendered if rendered else "0"
    return str(value)


def _qiskit_snippet(operations: list[dict[str, Any]], num_qubits: int, num_clbits: int) -> str:
    lines = [
        "from qiskit import QuantumCircuit",
        f"qc = QuantumCircuit({num_qubits}, {num_clbits})",
    ]

    for operation in operations:
        name = operation["name"]
        qubits = operation["qubits"]
        clbits = operation["clbits"]
        params = operation["params"]

        if name == "measure":
            if len(qubits) == len(clbits) and len(qubits) > 1:
                lines.append(f"qc.measure({qubits}, {clbits})")
            elif len(qubits) == 1 and len(clbits) == 1:
                lines.append(f"qc.measure({qubits[0]}, {clbits[0]})")
            else:
                lines.append(f"# measure mapping: qubits={qubits}, clbits={clbits}")
            continue

        args = [_python_literal(param) for param in params]
        args.extend(str(index) for index in qubits)

        if name == "barrier" and not qubits:
            lines.append("qc.barrier()")
            continue

        joined = ", ".join(args)
        lines.append(f"qc.{name}({joined})")

    return "\n".join(lines)


def _distribution_rows(counts: Mapping[str, Any] | None, probabilities: Mapping[str, Any] | None, shots: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    states = set()
    if counts:
        states.update(str(state) for state in counts.keys())
    if probabilities:
        states.update(str(state) for state in probabilities.keys())

    for state in states:
        raw_count = counts.get(state) if counts else None
        count = int(raw_count) if raw_count is not None else None

        raw_probability = probabilities.get(state) if probabilities else None
        if raw_probability is not None:
            probability = float(raw_probability)
        elif count is not None and shots > 0:
            probability = count / shots
        else:
            probability = 0.0

        rows.append(
            {
                "basis_state": state,
                "count": count,
                "probability": probability,
                "log_count": log10((count or 0) + 1),
            }
        )

    rows.sort(
        key=lambda row: (
            row["count"] if row["count"] is not None else int(row["probability"] * 1_000_000),
            row["basis_state"],
        ),
        reverse=True,
    )
    return rows


def _statevector_from_amplitudes(amplitudes: list[dict[str, Any]], num_qubits: int) -> np.ndarray:
    vector = np.zeros(2**num_qubits, dtype=complex)
    for amplitude in amplitudes:
        state = str(amplitude.get("basis_state", "")).zfill(num_qubits)
        if not state:
            continue
        index = int(state, 2)
        real = float(amplitude.get("real", 0.0))
        imag = float(amplitude.get("imag", 0.0))
        vector[index] = complex(real, imag)

    norm = np.linalg.norm(vector)
    if norm > 0:
        vector = vector / norm
    return vector


def _simulate_statevector(circuit_qasm: str, max_qubits: int = 6) -> tuple[list[dict[str, Any]], str | None]:
    circuit = circuit_from_qasm(circuit_qasm)
    sim_circuit = circuit.remove_final_measurements(inplace=False)
    if sim_circuit.num_qubits > max_qubits:
        return [], f"Statevector auto-derivation disabled for circuits > {max_qubits} qubits."

    backend = AerSimulator(method="statevector")
    sim_circuit.save_statevector()
    transpiled = transpile(sim_circuit, backend)
    result = backend.run(transpiled).result()
    statevector = result.get_statevector(transpiled)
    probabilities = statevector.probabilities_dict()

    amplitudes: list[dict[str, Any]] = []
    for basis_state, probability in sorted(probabilities.items(), key=lambda item: item[1], reverse=True):
        index = int(str(basis_state), 2)
        amplitude = statevector[index]
        amplitudes.append(
            {
                "basis_state": str(basis_state),
                "probability": float(probability),
                "real": float(amplitude.real),
                "imag": float(amplitude.imag),
            }
        )

    return amplitudes, None


def _bloch_vectors(amplitudes: list[dict[str, Any]], num_qubits: int) -> list[dict[str, Any]]:
    if num_qubits <= 0:
        return []
    vector = _statevector_from_amplitudes(amplitudes, num_qubits)
    if not np.any(vector):
        return []

    statevector = Statevector(vector)
    vectors: list[dict[str, Any]] = []
    for qubit in range(num_qubits):
        traced = partial_trace(statevector, [index for index in range(num_qubits) if index != qubit])
        density = traced.data
        rho01 = density[0, 1]
        x = float(2 * np.real(rho01))
        y = float(-2 * np.imag(rho01))
        z = float(np.real(density[0, 0] - density[1, 1]))
        purity = float(np.real(np.trace(density @ density)))
        vectors.append(
            {
                "qubit": qubit,
                "x": x,
                "y": y,
                "z": z,
                "purity": purity,
            }
        )
    return vectors


def enrich_job(job: dict[str, Any], *, include_heavy: bool) -> dict[str, Any]:
    payload = dict(job)
    payload["metadata"] = _json_safe(payload.get("metadata"))
    payload["input_payload"] = _json_safe(payload.get("input_payload"))
    payload["result_payload"] = _json_safe(payload.get("result_payload"))

    result_payload = payload.get("result_payload") if isinstance(payload.get("result_payload"), Mapping) else {}
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), Mapping) else {}

    derived: dict[str, Any] = {
        "duration_ms": _duration_ms(payload.get("created_at"), payload.get("updated_at")),
        "created_epoch_ms": int(_parse_timestamp(payload.get("created_at")).timestamp() * 1000)
        if _parse_timestamp(payload.get("created_at"))
        else None,
        "updated_epoch_ms": int(_parse_timestamp(payload.get("updated_at")).timestamp() * 1000)
        if _parse_timestamp(payload.get("updated_at"))
        else None,
    }

    counts = result_payload.get("counts") if isinstance(result_payload.get("counts"), Mapping) else None
    probabilities = (
        result_payload.get("probabilities") if isinstance(result_payload.get("probabilities"), Mapping) else None
    )
    shots = int(result_payload.get("shots") or payload.get("shots") or 0)
    derived["distribution"] = _distribution_rows(counts, probabilities, shots)

    circuit_qasm = payload.get("circuit_qasm")
    if isinstance(circuit_qasm, str) and circuit_qasm.strip():
        try:
            circuit = circuit_from_qasm(circuit_qasm)
            operations = _operation_payload(circuit)
            summary = circuit_summary(circuit)
            derived["circuit"] = {
                **summary,
                "layers": _layer_operations(operations),
                "operations": operations,
                "structured_gates": _structured_gates(operations),
                "qiskit_python": _qiskit_snippet(operations, circuit.num_qubits, circuit.num_clbits),
            }
        except Exception as exc:
            derived["circuit_error"] = str(exc)

    if include_heavy:
        amplitudes = result_payload.get("amplitudes") if isinstance(result_payload.get("amplitudes"), list) else []
        source = "job_payload"
        reason: str | None = None

        if not amplitudes and isinstance(circuit_qasm, str) and circuit_qasm.strip():
            amplitudes, reason = _simulate_statevector(circuit_qasm)
            if amplitudes:
                source = "derived_from_circuit"

        num_qubits = 0
        if isinstance(derived.get("circuit"), Mapping):
            num_qubits = int(derived["circuit"].get("num_qubits", 0))

        if amplitudes and num_qubits > 0:
            derived["statevector_source"] = source
            derived["amplitudes"] = amplitudes
            derived["bloch_vectors"] = _bloch_vectors(amplitudes, num_qubits)
        else:
            derived["statevector_source"] = None
            derived["amplitudes"] = []
            derived["bloch_vectors"] = []
            derived["bloch_unavailable_reason"] = reason or "Statevector data is unavailable for this job."

    replay_summary: dict[str, Any] = {}
    for key in ("algorithm", "grover_key", "oracle", "target_state", "notes"):
        if key in metadata:
            replay_summary[key] = metadata[key]
    if payload.get("shots") is not None:
        replay_summary["shots"] = payload["shots"]
    if payload.get("backend") is not None:
        replay_summary["backend"] = payload["backend"]
    if replay_summary:
        derived["replay"] = _json_safe(replay_summary)

    payload["derived"] = derived
    return payload


def enrich_jobs(jobs: list[dict[str, Any]], *, include_heavy: bool) -> list[dict[str, Any]]:
    return [enrich_job(job, include_heavy=include_heavy) for job in jobs]
