from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from mcp.server.mcpserver.exceptions import ToolError

from quantum_sandbox_mcp.api import app
from quantum_sandbox_mcp.engine import QuantumSandboxEngine
from quantum_sandbox_mcp.exceptions import MissingMeasurementError
from quantum_sandbox_mcp.mcp_server import create_circuit as create_circuit_tool
from quantum_sandbox_mcp.store import SQLiteStore


@pytest.fixture
def engine(tmp_path):
    store = SQLiteStore(tmp_path / "jobs.sqlite3")
    return QuantumSandboxEngine(store=store)


def test_bell_state_counts_are_near_50_50(engine: QuantumSandboxEngine) -> None:
    created = engine.create_circuit(
        num_qubits=2,
        gates=[
            {"gate": "h", "targets": [0]},
            {"gate": "cx", "targets": [0, 1]},
            {"gate": "measure", "targets": [0, 1], "clbits": [0, 1]},
        ],
    )
    run = engine.run_circuit(circuit_id=created["circuit_id"], shots=4096)

    counts = run["counts"]
    p00 = counts.get("00", 0) / 4096
    p11 = counts.get("11", 0) / 4096
    leakage = 1 - (p00 + p11)

    assert 0.40 <= p00 <= 0.60
    assert 0.40 <= p11 <= 0.60
    assert leakage < 0.05


def test_ghz_state_distribution(engine: QuantumSandboxEngine) -> None:
    created = engine.create_circuit(
        num_qubits=3,
        gates=[
            {"gate": "h", "targets": [0]},
            {"gate": "cx", "targets": [0, 1]},
            {"gate": "cx", "targets": [1, 2]},
            {"gate": "measure", "targets": [0, 1, 2], "clbits": [0, 1, 2]},
        ],
    )
    run = engine.run_circuit(circuit_id=created["circuit_id"], shots=4096)

    counts = run["counts"]
    p000 = counts.get("000", 0) / 4096
    p111 = counts.get("111", 0) / 4096
    leakage = 1 - (p000 + p111)

    assert 0.40 <= p000 <= 0.60
    assert 0.40 <= p111 <= 0.60
    assert leakage < 0.05


def test_openqasm_statevector(engine: QuantumSandboxEngine) -> None:
    qasm3 = """
OPENQASM 3;
include \"stdgates.inc\";
qubit[1] q;
h q[0];
""".strip()

    result = engine.simulate_statevector(qasm=qasm3)
    probabilities = result["probabilities"]

    assert probabilities["0"] == pytest.approx(0.5, abs=0.01)
    assert probabilities["1"] == pytest.approx(0.5, abs=0.01)


def test_openqasm2_u_gate_compatibility(engine: QuantumSandboxEngine) -> None:
    qasm2 = """
OPENQASM 2.0;
include "qelib1.inc";
qreg q[1];
creg c[1];
u(pi/2,0,pi) q[0];
measure q[0] -> c[0];
""".strip()

    run = engine.run_circuit(qasm=qasm2, shots=512)
    total = sum(run["counts"].values())
    assert total == 512


def test_explain_result(engine: QuantumSandboxEngine) -> None:
    explanation = engine.explain_result(counts={"00": 530, "11": 494}, shots=1024)

    assert explanation["dominant_state"] == "00"
    assert "Most likely state" in explanation["summary"]
    assert len(explanation["significant_outcomes"]) == 2


def test_missing_measurement_raises(engine: QuantumSandboxEngine) -> None:
    created = engine.create_circuit(
        num_qubits=1,
        num_clbits=1,
        gates=[{"gate": "h", "targets": [0]}],
    )

    with pytest.raises(MissingMeasurementError):
        engine.run_circuit(circuit_id=created["circuit_id"])


def test_qubits_alias_is_supported(engine: QuantumSandboxEngine) -> None:
    created = engine.create_circuit(
        num_qubits=2,
        gates=[
            {"gate": "h", "qubits": [0]},
            {"gate": "cx", "qubits": [0, 1]},
            {"gate": "measure", "qubits": [0, 1], "clbits": [0, 1]},
        ],
    )

    run = engine.run_circuit(circuit_id=created["circuit_id"], shots=1024)
    assert run["counts"].get("00", 0) > 0
    assert run["counts"].get("11", 0) > 0


def test_tool_error_surfaces_validation_message() -> None:
    with pytest.raises(ToolError, match="requires 'qubits'"):
        create_circuit_tool(num_qubits=1, gates=[{"gate": "h"}])


def test_oauth_discovery_endpoints_are_no_auth_friendly() -> None:
    with TestClient(app) as client:
        for path in (
            "/.well-known/oauth-protected-resource",
            "/.well-known/oauth-authorization-server",
            "/mcp/.well-known/openid-configuration",
        ):
            response = client.get(path)
            assert response.status_code == 200
            payload = response.json()
            assert payload["authorization_required"] is False
            assert payload["mcp_authentication"]["type"] == "none"
