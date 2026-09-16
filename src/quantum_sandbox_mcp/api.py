from __future__ import annotations

from datetime import datetime, time, timezone
import os
from pathlib import Path
from typing import Any

import uvicorn
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles

from .config import get_data_dir
from .exceptions import JobNotFoundError
from .job_views import build_circuit_view, enrich_job, enrich_jobs
from .mcp_server import engine, mcp


def _resolve_web_out_dir() -> Path | None:
    configured = os.getenv("QUANTUM_SANDBOX_WEB_OUT")
    candidates = []
    if configured:
        candidates.append(Path(configured).expanduser())
    module_path = Path(__file__).resolve()
    candidates.append(Path("/app/web/out"))
    candidates.extend(parent / "web" / "out" for parent in module_path.parents)
    candidates.append(Path.cwd() / "web" / "out")

    for candidate in candidates:
        resolved = candidate.resolve()
        if resolved.exists():
            return resolved
    return None


def _parse_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _parse_date_start(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _parse_date_end(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return datetime.combine(parsed.date(), time.max, tzinfo=timezone.utc)


def _job_matches_search(job: dict[str, Any], query: str) -> bool:
    if not query:
        return True
    lowered = query.lower()
    fields = [
        str(job.get("id", "")),
        str(job.get("kind", "")),
        str(job.get("status", "")),
        str(job.get("backend", "")),
        str(job.get("error", "")),
        str(job.get("created_at", "")),
        str(job.get("updated_at", "")),
        str(job.get("metadata", "")),
        str(job.get("input_payload", "")),
    ]
    return any(lowered in field.lower() for field in fields)


def _duration_ms(job: dict[str, Any]) -> int:
    start = _parse_timestamp(job.get("created_at"))
    end = _parse_timestamp(job.get("updated_at"))
    if start is None or end is None:
        return 0
    return max(int((end - start).total_seconds() * 1000), 0)


def _sort_jobs(jobs: list[dict[str, Any]], sort_by: str, sort_dir: str) -> list[dict[str, Any]]:
    reverse = sort_dir.lower() == "desc"

    def created_key(job: dict[str, Any]) -> float:
        return (_parse_timestamp(job.get("created_at")) or datetime.min).timestamp()

    def updated_key(job: dict[str, Any]) -> float:
        return (_parse_timestamp(job.get("updated_at")) or datetime.min).timestamp()

    if sort_by == "updated_at":
        key_fn = updated_key
    elif sort_by == "shots":
        key_fn = lambda job: int(job.get("shots") or 0)
    elif sort_by == "duration":
        key_fn = _duration_ms
    elif sort_by == "backend":
        key_fn = lambda job: str(job.get("backend") or "")
    elif sort_by == "status":
        key_fn = lambda job: str(job.get("status") or "")
    elif sort_by == "kind":
        key_fn = lambda job: str(job.get("kind") or "")
    else:
        key_fn = created_key

    return sorted(jobs, key=key_fn, reverse=reverse)


mcp_http_app = mcp.streamable_http_app(
    streamable_http_path="/mcp",
    host=os.getenv("MCP_ALLOWED_HOST", "0.0.0.0"),
)
mcp_http_app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=[
        "*",
        "MCP-Protocol-Version",
        "MCP-Session-Id",
        "Last-Event-ID",
    ],
    expose_headers=["MCP-Session-Id", "MCP-Protocol-Version"],
)

app = mcp_http_app


async def health(_: Request) -> Response:
    return JSONResponse({"status": "ok", "data_dir": str(get_data_dir())})


async def api_list_jobs(request: Request) -> Response:
    raw_limit = request.query_params.get("limit", "200")
    try:
        limit = int(raw_limit)
    except ValueError:
        return JSONResponse({"detail": "limit must be an integer"}, status_code=400)

    status = request.query_params.get("status")
    backend = request.query_params.get("backend")
    search = request.query_params.get("search", "").strip()
    start_date = _parse_date_start(request.query_params.get("start_date"))
    end_date = _parse_date_end(request.query_params.get("end_date"))
    sort_by = request.query_params.get("sort_by", "created_at")
    sort_dir = request.query_params.get("sort_dir", "desc")

    jobs = engine.list_jobs(limit=limit, status=status).get("jobs", [])

    filtered: list[dict[str, Any]] = []
    for job in jobs:
        if backend and str(job.get("backend") or "") != backend:
            continue
        if not _job_matches_search(job, search):
            continue

        created = _parse_timestamp(job.get("created_at"))
        if start_date and created and created < start_date:
            continue
        if end_date and created and created > end_date:
            continue

        filtered.append(job)

    sorted_jobs = _sort_jobs(filtered, sort_by=sort_by, sort_dir=sort_dir)
    enriched = enrich_jobs(sorted_jobs, include_heavy=False)
    return JSONResponse({"jobs": enriched, "total": len(enriched)})


async def api_get_job(request: Request) -> Response:
    job_id = request.path_params["job_id"]
    try:
        job = engine.get_job(job_id=job_id)
    except JobNotFoundError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=404)

    return JSONResponse(enrich_job(job, include_heavy=True))


async def api_list_circuits(request: Request) -> Response:
    raw_limit = request.query_params.get("limit", "100")
    try:
        limit = int(raw_limit)
    except ValueError:
        return JSONResponse({"detail": "limit must be an integer"}, status_code=400)
    return JSONResponse(engine.list_circuits(limit=limit))


async def _request_json(request: Request) -> tuple[dict[str, Any] | None, Response | None]:
    try:
        payload = await request.json()
    except Exception:
        return None, JSONResponse({"detail": "request body must be valid JSON"}, status_code=400)
    if not isinstance(payload, dict):
        return None, JSONResponse({"detail": "request body must be a JSON object"}, status_code=400)
    return payload, None


def _as_gate_list(payload: dict[str, Any]) -> list[dict[str, Any]] | None:
    gates = payload.get("gates")
    if gates is None:
        return None
    if not isinstance(gates, list) or not all(isinstance(item, dict) for item in gates):
        raise ValueError("'gates' must be a list of JSON objects.")
    return gates


async def api_create_circuit(request: Request) -> Response:
    payload, error = await _request_json(request)
    if error:
        return error
    assert payload is not None

    try:
        created = engine.create_circuit(
            num_qubits=int(payload["num_qubits"]) if payload.get("num_qubits") is not None else None,
            num_clbits=int(payload["num_clbits"]) if payload.get("num_clbits") is not None else None,
            name=str(payload["name"]) if payload.get("name") is not None else None,
            gates=_as_gate_list(payload),
            qasm=str(payload["qasm"]) if payload.get("qasm") is not None else None,
        )
    except (ValueError, TypeError) as exc:
        return JSONResponse({"detail": str(exc)}, status_code=400)
    except Exception as exc:
        return JSONResponse({"detail": str(exc)}, status_code=500)
    return JSONResponse(created, status_code=201)


def _resolve_run_circuit(payload: dict[str, Any]) -> tuple[str | None, str | None]:
    circuit_id = str(payload["circuit_id"]) if payload.get("circuit_id") else None
    qasm = str(payload["qasm"]) if payload.get("qasm") else None
    if circuit_id:
        return circuit_id, None
    return None, qasm


async def api_run(request: Request) -> Response:
    payload, error = await _request_json(request)
    if error:
        return error
    assert payload is not None

    try:
        gates = _as_gate_list(payload)
        circuit_id, qasm = _resolve_run_circuit(payload)
        if not circuit_id:
            created = engine.create_circuit(
                num_qubits=int(payload["num_qubits"]) if payload.get("num_qubits") is not None else None,
                num_clbits=int(payload["num_clbits"]) if payload.get("num_clbits") is not None else None,
                name=str(payload["name"]) if payload.get("name") is not None else None,
                gates=gates,
                qasm=qasm,
            )
            circuit_id = created["circuit_id"]

        run_result = engine.run_circuit(
            circuit_id=circuit_id,
            backend=str(payload.get("backend") or "aer_simulator"),
            shots=int(payload.get("shots") or 1024),
            metadata=payload.get("metadata") if isinstance(payload.get("metadata"), dict) else None,
        )
        job = engine.get_job(job_id=run_result["job_id"])
    except (ValueError, TypeError) as exc:
        return JSONResponse({"detail": str(exc)}, status_code=400)
    except Exception as exc:
        return JSONResponse({"detail": str(exc)}, status_code=500)

    return JSONResponse(
        {
            "circuit_id": circuit_id,
            "job": enrich_job(job, include_heavy=True),
        },
        status_code=201,
    )


async def api_statevector(request: Request) -> Response:
    payload, error = await _request_json(request)
    if error:
        return error
    assert payload is not None

    try:
        gates = _as_gate_list(payload)
        circuit_id, qasm = _resolve_run_circuit(payload)
        if not circuit_id:
            created = engine.create_circuit(
                num_qubits=int(payload["num_qubits"]) if payload.get("num_qubits") is not None else None,
                num_clbits=int(payload["num_clbits"]) if payload.get("num_clbits") is not None else None,
                name=str(payload["name"]) if payload.get("name") is not None else None,
                gates=gates,
                qasm=qasm,
            )
            circuit_id = created["circuit_id"]

        sim_result = engine.simulate_statevector(
            circuit_id=circuit_id,
            metadata=payload.get("metadata") if isinstance(payload.get("metadata"), dict) else None,
        )
        job = engine.get_job(job_id=sim_result["job_id"])
    except (ValueError, TypeError) as exc:
        return JSONResponse({"detail": str(exc)}, status_code=400)
    except Exception as exc:
        return JSONResponse({"detail": str(exc)}, status_code=500)

    return JSONResponse(
        {
            "circuit_id": circuit_id,
            "job": enrich_job(job, include_heavy=True),
        },
        status_code=201,
    )


async def api_circuit_model(request: Request) -> Response:
    payload, error = await _request_json(request)
    if error:
        return error
    assert payload is not None

    try:
        if payload.get("circuit_id"):
            persisted = engine.get_circuit(circuit_id=str(payload["circuit_id"]))
            qasm = str(persisted["qasm"])
        elif payload.get("qasm"):
            qasm = str(payload["qasm"])
        else:
            return JSONResponse({"detail": "Provide circuit_id or qasm."}, status_code=400)

        model = build_circuit_view(qasm)
    except (ValueError, TypeError) as exc:
        return JSONResponse({"detail": str(exc)}, status_code=400)
    except Exception as exc:
        return JSONResponse({"detail": str(exc)}, status_code=500)
    return JSONResponse({"qasm": qasm, "circuit": model})


def _discovery_payload(base_url: str) -> dict[str, object]:
    return {
        "resource": f"{base_url}/mcp",
        "issuer": base_url,
        "authorization_servers": [],
        "authorization_required": False,
        "mcp_authentication": {"type": "none"},
    }


async def oauth_protected_resource(request: Request) -> Response:
    base = str(request.base_url).rstrip("/")
    return JSONResponse(_discovery_payload(base))


async def oauth_authorization_server(request: Request) -> Response:
    base = str(request.base_url).rstrip("/")
    payload = _discovery_payload(base)
    payload.update(
        {
            "authorization_endpoint": None,
            "token_endpoint": None,
            "grant_types_supported": [],
            "response_types_supported": [],
            "token_endpoint_auth_methods_supported": [],
        }
    )
    return JSONResponse(payload)


async def openid_configuration(request: Request) -> Response:
    base = str(request.base_url).rstrip("/")
    payload = _discovery_payload(base)
    payload.update(
        {
            "authorization_endpoint": None,
            "token_endpoint": None,
            "jwks_uri": None,
            "subject_types_supported": [],
            "id_token_signing_alg_values_supported": [],
        }
    )
    return JSONResponse(payload)


web_out_dir = _resolve_web_out_dir()
web_index_file = web_out_dir / "index.html" if web_out_dir else None


async def dashboard_unavailable(_: Request) -> Response:
    return JSONResponse(
        {
            "message": "Web dashboard is not built yet. Run `npm install && npm run build` in ./web.",
        },
        status_code=503,
    )


async def serve_job_deep_link(request: Request) -> Response:
    if web_index_file and web_index_file.exists():
        return FileResponse(str(web_index_file))
    return await dashboard_unavailable(request)


mcp_http_app.add_route("/health", health, methods=["GET"])
mcp_http_app.add_route("/api/jobs", api_list_jobs, methods=["GET"])
mcp_http_app.add_route("/api/jobs/{job_id:str}", api_get_job, methods=["GET"])
mcp_http_app.add_route("/api/circuits", api_list_circuits, methods=["GET"])
mcp_http_app.add_route("/api/circuits", api_create_circuit, methods=["POST"])
mcp_http_app.add_route("/api/run", api_run, methods=["POST"])
mcp_http_app.add_route("/api/statevector", api_statevector, methods=["POST"])
mcp_http_app.add_route("/api/circuit-model", api_circuit_model, methods=["POST"])
mcp_http_app.add_route("/jobs/{job_id:str}", serve_job_deep_link, methods=["GET"])
mcp_http_app.add_route(
    "/.well-known/oauth-protected-resource",
    oauth_protected_resource,
    methods=["GET"],
)
mcp_http_app.add_route(
    "/.well-known/oauth-authorization-server",
    oauth_authorization_server,
    methods=["GET"],
)
mcp_http_app.add_route(
    "/mcp/.well-known/openid-configuration",
    openid_configuration,
    methods=["GET"],
)
if web_out_dir:
    mcp_http_app.mount(
        "/",
        StaticFiles(directory=str(web_out_dir), html=True),
        name="dashboard",
    )
else:
    mcp_http_app.add_route("/", dashboard_unavailable, methods=["GET"])


def run() -> None:
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("quantum_sandbox_mcp.api:app", host="0.0.0.0", port=port, reload=False)


if __name__ == "__main__":
    run()
