from __future__ import annotations

from collections.abc import Mapping, Sequence
from math import pi
from typing import Any

from qiskit import QuantumCircuit
import qiskit.qasm2 as qasm2
import qiskit.qasm3 as qasm3


def circuit_from_qasm(qasm_source: str) -> QuantumCircuit:
    errors: list[str] = []
    try:
        return qasm2.loads(qasm_source)
    except Exception as exc:  # pragma: no cover - error path only
        errors.append(f"OpenQASM 2 parse failed: {exc}")

    try:
        return qasm3.loads(qasm_source)
    except Exception as exc:
        errors.append(f"OpenQASM 3 parse failed: {exc}")

    raise ValueError("Could not parse provided QASM. " + " | ".join(errors))


def circuit_to_qasm(circuit: QuantumCircuit) -> str:
    try:
        return qasm3.dumps(circuit)
    except Exception:
        return qasm2.dumps(circuit)


def has_measurements(circuit: QuantumCircuit) -> bool:
    return any(instruction.operation.name == "measure" for instruction in circuit.data)


def infer_required_qubits(gates: Sequence[Mapping[str, Any]]) -> int:
    highest = -1
    for gate in gates:
        for key in ("targets", "qubits", "controls"):
            for index in gate.get(key, []):
                highest = max(highest, int(index))
    return highest + 1 if highest >= 0 else 0


def infer_required_clbits(gates: Sequence[Mapping[str, Any]]) -> int:
    highest = -1
    for gate in gates:
        for index in gate.get("clbits", []):
            highest = max(highest, int(index))
    return highest + 1 if highest >= 0 else 0


def _require_gate_name(spec: Mapping[str, Any]) -> str:
    gate = str(spec.get("gate", "")).strip().lower()
    if not gate:
        raise ValueError("Each gate spec must include a non-empty 'gate' field.")
    return gate


def _targets(spec: Mapping[str, Any]) -> list[int]:
    raw_targets = spec.get("targets", [])
    if raw_targets:
        return [int(value) for value in raw_targets]
    return [int(value) for value in spec.get("qubits", [])]


def _controls(spec: Mapping[str, Any]) -> list[int]:
    return [int(value) for value in spec.get("controls", [])]


def _params(spec: Mapping[str, Any]) -> list[float]:
    return [float(value) for value in spec.get("params", [])]


def _clbits(spec: Mapping[str, Any]) -> list[int]:
    return [int(value) for value in spec.get("clbits", [])]


def _pair_controls_targets(spec: Mapping[str, Any]) -> list[tuple[int, int]]:
    targets = _targets(spec)
    controls = _controls(spec)

    if not targets:
        raise ValueError("Controlled gate requires at least one target index.")

    if controls:
        if len(controls) == len(targets):
            return list(zip(controls, targets, strict=True))
        if len(controls) == 1:
            return [(controls[0], target) for target in targets]
        raise ValueError(
            "Controls and qubits lengths must match, or provide one control for many qubits."
        )

    if len(targets) == 2:
        return [(targets[0], targets[1])]

    raise ValueError(
        "Controlled gate requires controls, or qubits=[control,target] (alias: targets=[...])."
    )


def apply_gates(circuit: QuantumCircuit, gates: Sequence[Mapping[str, Any]]) -> None:
    for raw_spec in gates:
        if not isinstance(raw_spec, Mapping):
            raise ValueError("Each gate item must be an object/dict.")

        spec = raw_spec
        gate = _require_gate_name(spec)
        targets = _targets(spec)
        controls = _controls(spec)
        params = _params(spec)

        if gate in {"x", "y", "z", "h", "s", "sdg", "t", "tdg", "sx", "id", "reset"}:
            if not targets:
                raise ValueError(f"Gate '{gate}' requires 'qubits' (alias: 'targets').")
            for target in targets:
                getattr(circuit, gate)(target)
            continue

        if gate in {"rx", "ry", "rz", "p"}:
            if len(params) != 1:
                raise ValueError(f"Gate '{gate}' expects exactly 1 parameter.")
            if not targets:
                raise ValueError(f"Gate '{gate}' requires 'qubits' (alias: 'targets').")
            for target in targets:
                getattr(circuit, gate)(params[0], target)
            continue

        if gate == "u":
            if len(params) != 3:
                raise ValueError("Gate 'u' expects exactly 3 parameters.")
            if not targets:
                raise ValueError("Gate 'u' requires 'qubits' (alias: 'targets').")
            for target in targets:
                circuit.u(params[0], params[1], params[2], target)
            continue

        if gate == "u1":
            if len(params) != 1:
                raise ValueError("Gate 'u1' expects exactly 1 parameter.")
            for target in targets:
                circuit.p(params[0], target)
            continue

        if gate == "u2":
            if len(params) != 2:
                raise ValueError("Gate 'u2' expects exactly 2 parameters.")
            for target in targets:
                circuit.u(pi / 2, params[0], params[1], target)
            continue

        if gate == "u3":
            if len(params) != 3:
                raise ValueError("Gate 'u3' expects exactly 3 parameters.")
            for target in targets:
                circuit.u(params[0], params[1], params[2], target)
            continue

        if gate in {"cx", "cnot", "cy", "cz", "ch"}:
            method_name = "cx" if gate == "cnot" else gate
            for control, target in _pair_controls_targets(spec):
                getattr(circuit, method_name)(control, target)
            continue

        if gate == "swap":
            if len(targets) == 2:
                circuit.swap(targets[0], targets[1])
                continue
            if len(controls) == 1 and len(targets) == 1:
                circuit.swap(controls[0], targets[0])
                continue
            raise ValueError(
                "Swap requires two indexes via qubits=[a,b] (alias: targets=[a,b]) or "
                "controls=[a],qubits=[b]."
            )

        if gate in {"cp", "crx", "cry", "crz"}:
            if len(params) != 1:
                raise ValueError(f"Gate '{gate}' expects exactly 1 parameter.")
            for control, target in _pair_controls_targets(spec):
                getattr(circuit, gate)(params[0], control, target)
            continue

        if gate == "ccx":
            if len(controls) == 2 and len(targets) == 1:
                circuit.ccx(controls[0], controls[1], targets[0])
                continue
            if len(targets) == 3:
                circuit.ccx(targets[0], targets[1], targets[2])
                continue
            raise ValueError(
                "CCX requires controls=[c1,c2], qubits=[t] or qubits=[c1,c2,t] "
                "(alias: targets=[...])."
            )

        if gate == "measure":
            if not targets:
                if circuit.num_qubits == 0 or circuit.num_clbits == 0:
                    raise ValueError("Cannot infer measurement mapping from an empty circuit.")
                pair_count = min(circuit.num_qubits, circuit.num_clbits)
                circuit.measure(list(range(pair_count)), list(range(pair_count)))
                continue

            clbits = _clbits(spec)
            if not clbits:
                clbits = targets
            if len(clbits) != len(targets):
                raise ValueError("Measurement requires equal numbers of qubits (or targets) and clbits.")
            circuit.measure(targets, clbits)
            continue

        if gate == "barrier":
            if targets:
                circuit.barrier(*targets)
            else:
                circuit.barrier()
            continue

        raise ValueError(f"Unsupported gate '{gate}'.")


def circuit_summary(circuit: QuantumCircuit) -> dict[str, Any]:
    gate_counts = {str(name): int(count) for name, count in circuit.count_ops().items()}
    return {
        "num_qubits": circuit.num_qubits,
        "num_clbits": circuit.num_clbits,
        "depth": int(circuit.depth() or 0),
        "size": int(circuit.size()),
        "gate_counts": gate_counts,
        "has_measurements": has_measurements(circuit),
    }
