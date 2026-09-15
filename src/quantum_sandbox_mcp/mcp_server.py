from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from mcp.server.mcpserver import MCPServer

from .engine import QuantumSandboxEngine

engine = QuantumSandboxEngine()
mcp = MCPServer("quantum-sandbox-mcp")


@mcp.tool(description="List available Qiskit Aer simulation backends.")
def list_backends() -> dict[str, Any]:
    return engine.list_backends()


@mcp.tool(description="Create and persist a circuit from qubits, gates, or OpenQASM.")
def create_circuit(
    num_qubits: int | None = None,
    num_clbits: int | None = None,
    name: str | None = None,
    gates: Sequence[Mapping[str, Any]] | None = None,
    qasm: str | None = None,
) -> dict[str, Any]:
    return engine.create_circuit(
        num_qubits=num_qubits,
        num_clbits=num_clbits,
        name=name,
        gates=gates,
        qasm=qasm,
    )


@mcp.tool(description="Alias for create_circuit.")
def build_circuit(
    num_qubits: int | None = None,
    num_clbits: int | None = None,
    name: str | None = None,
    gates: Sequence[Mapping[str, Any]] | None = None,
    qasm: str | None = None,
) -> dict[str, Any]:
    return create_circuit(
        num_qubits=num_qubits,
        num_clbits=num_clbits,
        name=name,
        gates=gates,
        qasm=qasm,
    )


@mcp.tool(description="Append structured gates to an existing circuit and persist it.")
def add_gates(circuit_id: str, gates: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return engine.add_gates(circuit_id=circuit_id, gates=gates)


@mcp.tool(description="Alias for add_gates.")
def append_to_circuit(circuit_id: str, gates: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return add_gates(circuit_id=circuit_id, gates=gates)


@mcp.tool(description="Describe a circuit's structure and operation counts.")
def describe_circuit(
    circuit_id: str | None = None,
    qasm: str | None = None,
    gates: Sequence[Mapping[str, Any]] | None = None,
    num_qubits: int | None = None,
    num_clbits: int | None = None,
) -> dict[str, Any]:
    return engine.describe_circuit(
        circuit_id=circuit_id,
        qasm=qasm,
        gates=gates,
        num_qubits=num_qubits,
        num_clbits=num_clbits,
    )


@mcp.tool(description="Run a circuit on a Qiskit Aer backend and store the result as a Job.")
def run_circuit(
    circuit_id: str | None = None,
    qasm: str | None = None,
    gates: Sequence[Mapping[str, Any]] | None = None,
    num_qubits: int | None = None,
    num_clbits: int | None = None,
    backend: str = "aer_simulator",
    shots: int = 1024,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return engine.run_circuit(
        circuit_id=circuit_id,
        qasm=qasm,
        gates=gates,
        num_qubits=num_qubits,
        num_clbits=num_clbits,
        backend=backend,
        shots=shots,
        metadata=dict(metadata) if metadata else None,
    )


@mcp.tool(description="Run statevector simulation and store the result as a Job.")
def simulate_statevector(
    circuit_id: str | None = None,
    qasm: str | None = None,
    gates: Sequence[Mapping[str, Any]] | None = None,
    num_qubits: int | None = None,
    num_clbits: int | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return engine.simulate_statevector(
        circuit_id=circuit_id,
        qasm=qasm,
        gates=gates,
        num_qubits=num_qubits,
        num_clbits=num_clbits,
        metadata=dict(metadata) if metadata else None,
    )


@mcp.tool(description="Estimate complexity and rough runtime of a circuit.")
def estimate(
    circuit_id: str | None = None,
    qasm: str | None = None,
    gates: Sequence[Mapping[str, Any]] | None = None,
    num_qubits: int | None = None,
    num_clbits: int | None = None,
    shots: int = 1024,
) -> dict[str, Any]:
    return engine.estimate(
        circuit_id=circuit_id,
        qasm=qasm,
        gates=gates,
        num_qubits=num_qubits,
        num_clbits=num_clbits,
        shots=shots,
    )


@mcp.tool(description="Explain measurement counts from a job or explicit counts payload.")
def explain_result(
    job_id: str | None = None,
    counts: Mapping[str, int] | None = None,
    shots: int | None = None,
) -> dict[str, Any]:
    return engine.explain_result(job_id=job_id, counts=counts, shots=shots)


@mcp.tool(description="Fetch a persisted job by id.")
def get_job(job_id: str) -> dict[str, Any]:
    return engine.get_job(job_id=job_id)


@mcp.tool(description="List persisted jobs with optional status filtering.")
def list_jobs(limit: int = 20, status: str | None = None) -> dict[str, Any]:
    return engine.list_jobs(limit=limit, status=status)
