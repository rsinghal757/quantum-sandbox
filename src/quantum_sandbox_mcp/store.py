from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import get_db_path
from .exceptions import CircuitNotFoundError, JobNotFoundError


class SQLiteStore:
    """Persistent store for circuits and execution jobs."""

    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = Path(db_path) if db_path else get_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS circuits (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    num_qubits INTEGER NOT NULL,
                    num_clbits INTEGER NOT NULL,
                    qasm TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    backend TEXT,
                    shots INTEGER,
                    input_payload TEXT,
                    circuit_qasm TEXT,
                    metadata TEXT,
                    result_payload TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _serialize(payload: dict[str, Any] | None) -> str | None:
        if payload is None:
            return None
        return json.dumps(payload, sort_keys=True)

    @staticmethod
    def _deserialize(payload: str | None) -> dict[str, Any] | None:
        if payload is None:
            return None
        return json.loads(payload)

    def save_circuit(
        self,
        *,
        circuit_id: str,
        name: str | None,
        num_qubits: int,
        num_clbits: int,
        qasm: str,
    ) -> None:
        now = self._now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO circuits (id, name, num_qubits, num_clbits, qasm, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (circuit_id, name, num_qubits, num_clbits, qasm, now, now),
            )

    def update_circuit(
        self,
        *,
        circuit_id: str,
        qasm: str,
        num_qubits: int,
        num_clbits: int,
    ) -> None:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE circuits
                   SET qasm = ?, num_qubits = ?, num_clbits = ?, updated_at = ?
                 WHERE id = ?
                """,
                (qasm, num_qubits, num_clbits, self._now(), circuit_id),
            )
            if cursor.rowcount == 0:
                raise CircuitNotFoundError(f"Circuit '{circuit_id}' was not found.")

    def get_circuit(self, circuit_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM circuits WHERE id = ?", (circuit_id,)).fetchone()
        if row is None:
            raise CircuitNotFoundError(f"Circuit '{circuit_id}' was not found.")
        return dict(row)

    def list_circuits(self, *, limit: int = 100) -> list[dict[str, Any]]:
        bounded_limit = max(1, min(limit, 500))
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT *
                  FROM circuits
              ORDER BY updated_at DESC
                 LIMIT ?
                """,
                (bounded_limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_job(
        self,
        *,
        job_id: str,
        kind: str,
        backend: str,
        shots: int,
        input_payload: dict[str, Any],
        circuit_qasm: str,
        metadata: dict[str, Any] | None,
    ) -> None:
        now = self._now()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO jobs (
                    id,
                    kind,
                    status,
                    backend,
                    shots,
                    input_payload,
                    circuit_qasm,
                    metadata,
                    result_payload,
                    error,
                    created_at,
                    updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    kind,
                    "running",
                    backend,
                    shots,
                    self._serialize(input_payload),
                    circuit_qasm,
                    self._serialize(metadata),
                    None,
                    None,
                    now,
                    now,
                ),
            )

    def complete_job(self, job_id: str, result_payload: dict[str, Any]) -> None:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE jobs
                   SET status = ?, result_payload = ?, updated_at = ?, error = NULL
                 WHERE id = ?
                """,
                ("completed", self._serialize(result_payload), self._now(), job_id),
            )
            if cursor.rowcount == 0:
                raise JobNotFoundError(f"Job '{job_id}' was not found.")

    def fail_job(self, job_id: str, error: str) -> None:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE jobs
                   SET status = ?, error = ?, updated_at = ?
                 WHERE id = ?
                """,
                ("failed", error, self._now(), job_id),
            )
            if cursor.rowcount == 0:
                raise JobNotFoundError(f"Job '{job_id}' was not found.")

    def get_job(self, job_id: str) -> dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFoundError(f"Job '{job_id}' was not found.")

        payload = dict(row)
        payload["input_payload"] = self._deserialize(payload["input_payload"])
        payload["metadata"] = self._deserialize(payload["metadata"])
        payload["result_payload"] = self._deserialize(payload["result_payload"])
        return payload

    def list_jobs(self, *, limit: int = 20, status: str | None = None) -> list[dict[str, Any]]:
        bounded_limit = max(1, min(limit, 200))
        where_clause = ""
        params: tuple[Any, ...]
        if status:
            where_clause = "WHERE status = ?"
            params = (status, bounded_limit)
        else:
            params = (bounded_limit,)

        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT *
                  FROM jobs
                  {where_clause}
              ORDER BY created_at DESC
                 LIMIT ?
                """,
                params,
            ).fetchall()

        jobs: list[dict[str, Any]] = []
        for row in rows:
            payload = dict(row)
            payload["input_payload"] = self._deserialize(payload["input_payload"])
            payload["metadata"] = self._deserialize(payload["metadata"])
            payload["result_payload"] = self._deserialize(payload["result_payload"])
            jobs.append(payload)
        return jobs
