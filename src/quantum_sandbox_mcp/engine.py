from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any
from uuid import uuid4

from qiskit import QuantumCircuit, transpile
from qiskit_aer import Aer, AerSimulator

from .circuit_utils import (
    apply_gates,
    circuit_from_qasm,
    circuit_summary,
    circuit_to_qasm,
    has_measurements,
    infer_required_clbits,
    infer_required_qubits,
)
from .exceptions import MissingMeasurementError
from .store import SQLiteStore

TWO_QUBIT_GATES = {
    "cx",
    "cy",
    "cz",
    "ch",
    "cp",
    "crx",
    "cry",
    "crz",
    "swap",
    "rxx",
    "ryy",
    "rzz",
    "ecr",
}


class QuantumSandboxEngine:
    def __init__(self, store: SQLiteStore | None = None) -> None:
        self.store = store or SQLiteStore()

    @staticmethod
    def _as_gate_list(gates: Sequence[Mapping[str, Any]] | None) -> list[Mapping[str, Any]]:
        return list(gates or [])

    def _resolve_circuit(
        self,
        *,
        circuit_id: str | None = None,
        qasm: str | None = None,
        gates: Sequence[Mapping[str, Any]] | None = None,
        num_qubits: int | None = None,
        num_clbits: int | None = None,
    ) -> tuple[QuantumCircuit, dict[str, Any]]:
        gate_list = self._as_gate_list(gates)

        if circuit_id:
            persisted = self.store.get_circuit(circuit_id)
            circuit = circuit_from_qasm(persisted["qasm"])
            source = {"type": "circuit_id", "circuit_id": circuit_id}
            if gate_list:
                apply_gates(circuit, gate_list)
            return circuit, source

        if qasm:
            circuit = circuit_from_qasm(qasm)
            source = {"type": "qasm"}
            if gate_list:
                apply_gates(circuit, gate_list)
            return circuit, source

        if not gate_list and num_qubits is None:
            raise ValueError("Provide one of: circuit_id, qasm, or gates (with optional num_qubits).")

        inferred_qubits = infer_required_qubits(gate_list)
        inferred_clbits = infer_required_clbits(gate_list)
        qubits = num_qubits if num_qubits is not None else inferred_qubits
        if qubits <= 0:
            raise ValueError("Unable to infer qubit count. Provide num_qubits.")

        clbits = num_clbits if num_clbits is not None else max(qubits, inferred_clbits)
        circuit = QuantumCircuit(qubits, clbits)
        if gate_list:
            apply_gates(circuit, gate_list)
        return circuit, {"type": "gate_list"}

    def list_backends(self) -> dict[str, Any]:
        names: list[str] = []
        for backend in Aer.backends():
            name_attr = getattr(backend, "name", None)
            name = name_attr() if callable(name_attr) else name_attr
            if isinstance(name, str):
                names.append(name)
        names = sorted(set(names))
        if "aer_simulator" not in names:
            names.insert(0, "aer_simulator")
        return {"default_backend": "aer_simulator", "backends": names}

    def create_circuit(
        self,
        *,
        num_qubits: int | None = None,
        num_clbits: int | None = None,
        name: str | None = None,
        gates: Sequence[Mapping[str, Any]] | None = None,
        qasm: str | None = None,
    ) -> dict[str, Any]:
        circuit, _ = self._resolve_circuit(
            qasm=qasm,
            gates=gates,
            num_qubits=num_qubits,
            num_clbits=num_clbits,
        )
        circuit_id = str(uuid4())
        payload_qasm = circuit_to_qasm(circuit)
        self.store.save_circuit(
            circuit_id=circuit_id,
            name=name,
            num_qubits=circuit.num_qubits,
            num_clbits=circuit.num_clbits,
            qasm=payload_qasm,
        )

        summary = circuit_summary(circuit)
        return {
            "circuit_id": circuit_id,
            "name": name,
            "qasm": payload_qasm,
            **summary,
        }

    def add_gates(
        self,
        *,
        circuit_id: str,
        gates: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        persisted = self.store.get_circuit(circuit_id)
        circuit = circuit_from_qasm(persisted["qasm"])
        apply_gates(circuit, list(gates))

        payload_qasm = circuit_to_qasm(circuit)
        self.store.update_circuit(
            circuit_id=circuit_id,
            qasm=payload_qasm,
            num_qubits=circuit.num_qubits,
            num_clbits=circuit.num_clbits,
        )
        return {"circuit_id": circuit_id, "qasm": payload_qasm, **circuit_summary(circuit)}

    def describe_circuit(
        self,
        *,
        circuit_id: str | None = None,
        qasm: str | None = None,
        gates: Sequence[Mapping[str, Any]] | None = None,
        num_qubits: int | None = None,
        num_clbits: int | None = None,
    ) -> dict[str, Any]:
        circuit, source = self._resolve_circuit(
            circuit_id=circuit_id,
            qasm=qasm,
            gates=gates,
            num_qubits=num_qubits,
            num_clbits=num_clbits,
        )
        summary = circuit_summary(circuit)
        return {"source": source, "qasm": circuit_to_qasm(circuit), **summary}

    def _start_job(
        self,
        *,
        kind: str,
        backend: str,
        shots: int,
        source: dict[str, Any],
        circuit: QuantumCircuit,
        metadata: dict[str, Any] | None,
    ) -> str:
        job_id = str(uuid4())
        self.store.create_job(
            job_id=job_id,
            kind=kind,
            backend=backend,
            shots=shots,
            input_payload=source,
            circuit_qasm=circuit_to_qasm(circuit),
            metadata=metadata,
        )
        return job_id

    def run_circuit(
        self,
        *,
        circuit_id: str | None = None,
        qasm: str | None = None,
        gates: Sequence[Mapping[str, Any]] | None = None,
        num_qubits: int | None = None,
        num_clbits: int | None = None,
        backend: str = "aer_simulator",
        shots: int = 1024,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if shots <= 0:
            raise ValueError("shots must be a positive integer.")

        circuit, source = self._resolve_circuit(
            circuit_id=circuit_id,
            qasm=qasm,
            gates=gates,
            num_qubits=num_qubits,
            num_clbits=num_clbits,
        )

        if not has_measurements(circuit):
            raise MissingMeasurementError(
                "Circuit has no measurements. Add measure gates or use simulate_statevector()."
            )

        job_id = self._start_job(
            kind="run_circuit",
            backend=backend,
            shots=shots,
            source=source,
            circuit=circuit,
            metadata=metadata,
        )

        try:
            backend_obj = Aer.get_backend(backend)
            transpiled = transpile(circuit, backend_obj)
            run_job = backend_obj.run(transpiled, shots=shots)
            result = run_job.result()
            counts = result.get_counts()
            if isinstance(counts, list):
                counts = counts[0]
            normalized = {state: value / shots for state, value in counts.items()}
            payload = {
                "backend": backend,
                "shots": shots,
                "counts": {state: int(value) for state, value in counts.items()},
                "probabilities": normalized,
            }
            self.store.complete_job(job_id, payload)
            return {"job_id": job_id, **payload}
        except Exception as exc:
            self.store.fail_job(job_id, str(exc))
            raise

    def simulate_statevector(
        self,
        *,
        circuit_id: str | None = None,
        qasm: str | None = None,
        gates: Sequence[Mapping[str, Any]] | None = None,
        num_qubits: int | None = None,
        num_clbits: int | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        circuit, source = self._resolve_circuit(
            circuit_id=circuit_id,
            qasm=qasm,
            gates=gates,
            num_qubits=num_qubits,
            num_clbits=num_clbits,
        )

        # Measurement-free circuit preserves amplitudes for analysis.
        simulation_circuit = circuit.remove_final_measurements(inplace=False)

        job_id = self._start_job(
            kind="simulate_statevector",
            backend="aer_simulator_statevector",
            shots=0,
            source=source,
            circuit=simulation_circuit,
            metadata=metadata,
        )

        try:
            backend = AerSimulator(method="statevector")
            simulation_circuit.save_statevector()
            transpiled = transpile(simulation_circuit, backend)
            result = backend.run(transpiled).result()
            statevector = result.get_statevector(transpiled)
            probabilities = {
                state: float(value)
                for state, value in statevector.probabilities_dict().items()
            }

            amplitudes: list[dict[str, Any]] = []
            for state, probability in sorted(probabilities.items(), key=lambda item: item[1], reverse=True):
                index = int(state, 2)
                amplitude = statevector[index]
                amplitudes.append(
                    {
                        "basis_state": state,
                        "probability": probability,
                        "real": float(amplitude.real),
                        "imag": float(amplitude.imag),
                    }
                )

            payload = {
                "num_qubits": simulation_circuit.num_qubits,
                "probabilities": probabilities,
                "amplitudes": amplitudes,
            }
            self.store.complete_job(job_id, payload)
            return {"job_id": job_id, **payload}
        except Exception as exc:
            self.store.fail_job(job_id, str(exc))
            raise

    def estimate(
        self,
        *,
        circuit_id: str | None = None,
        qasm: str | None = None,
        gates: Sequence[Mapping[str, Any]] | None = None,
        num_qubits: int | None = None,
        num_clbits: int | None = None,
        shots: int = 1024,
    ) -> dict[str, Any]:
        circuit, source = self._resolve_circuit(
            circuit_id=circuit_id,
            qasm=qasm,
            gates=gates,
            num_qubits=num_qubits,
            num_clbits=num_clbits,
        )
        summary = circuit_summary(circuit)
        gate_counts = summary["gate_counts"]
        two_qubit_ops = sum(gate_counts.get(name, 0) for name in TWO_QUBIT_GATES)
        single_qubit_ops = max(summary["size"] - two_qubit_ops, 0)
        runtime_ms = int((single_qubit_ops * 0.02 + two_qubit_ops * 0.08) * shots)

        return {
            "source": source,
            "shots": shots,
            "estimated_runtime_ms": runtime_ms,
            "estimated_memory_kb": int((2 ** summary["num_qubits"]) / 16),
            "num_two_qubit_ops": two_qubit_ops,
            **summary,
        }

    def explain_result(
        self,
        *,
        job_id: str | None = None,
        counts: Mapping[str, int] | None = None,
        shots: int | None = None,
    ) -> dict[str, Any]:
        resolved_counts: dict[str, int]
        resolved_shots: int

        if job_id:
            job = self.store.get_job(job_id)
            payload = job.get("result_payload") or {}
            payload_counts = payload.get("counts")
            if not isinstance(payload_counts, dict):
                raise ValueError("Requested job does not contain shot-based counts.")
            resolved_counts = {str(key): int(value) for key, value in payload_counts.items()}
            resolved_shots = int(payload.get("shots") or sum(resolved_counts.values()))
        elif counts:
            resolved_counts = {str(key): int(value) for key, value in counts.items()}
            resolved_shots = int(shots or sum(resolved_counts.values()))
        else:
            raise ValueError("Provide job_id or counts for explain_result.")

        if resolved_shots <= 0:
            raise ValueError("shots must be positive.")

        ranked = sorted(resolved_counts.items(), key=lambda item: item[1], reverse=True)
        dominant_state, dominant_count = ranked[0]
        dominant_probability = dominant_count / resolved_shots

        significant = [
            {
                "basis_state": state,
                "count": count,
                "probability": count / resolved_shots,
            }
            for state, count in ranked
            if (count / resolved_shots) >= 0.01
        ]

        summary = (
            f"Most likely state is |{dominant_state}> at {dominant_probability:.2%} "
            f"across {resolved_shots} shots with {len(significant)} significant outcomes."
        )

        return {
            "shots": resolved_shots,
            "dominant_state": dominant_state,
            "dominant_probability": dominant_probability,
            "significant_outcomes": significant,
            "summary": summary,
        }

    def get_job(self, *, job_id: str) -> dict[str, Any]:
        return self.store.get_job(job_id)

    def list_jobs(self, *, limit: int = 20, status: str | None = None) -> dict[str, Any]:
        return {"jobs": self.store.list_jobs(limit=limit, status=status)}
