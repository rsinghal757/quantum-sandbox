from __future__ import annotations

import os
from pathlib import Path

import uvicorn
from fastapi.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.staticfiles import StaticFiles

from .config import get_data_dir
from .exceptions import JobNotFoundError
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
    raw_limit = request.query_params.get("limit", "25")
    try:
        limit = int(raw_limit)
    except ValueError:
        return JSONResponse({"detail": "limit must be an integer"}, status_code=400)
    status = request.query_params.get("status")
    return JSONResponse(engine.list_jobs(limit=limit, status=status))


async def api_get_job(request: Request) -> Response:
    job_id = request.path_params["job_id"]
    try:
        return JSONResponse(engine.get_job(job_id=job_id))
    except JobNotFoundError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=404)


web_out_dir = _resolve_web_out_dir()
mcp_http_app.add_route("/health", health, methods=["GET"])
mcp_http_app.add_route("/api/jobs", api_list_jobs, methods=["GET"])
mcp_http_app.add_route("/api/jobs/{job_id:str}", api_get_job, methods=["GET"])
if web_out_dir:
    mcp_http_app.mount(
        "/",
        StaticFiles(directory=str(web_out_dir), html=True),
        name="dashboard",
    )
else:

    async def dashboard_unavailable(_: Request) -> Response:
        return JSONResponse(
            {
                "message": "Web dashboard is not built yet. Run `npm install && npm run build` in ./web.",
            },
            status_code=503,
        )

    mcp_http_app.add_route("/", dashboard_unavailable, methods=["GET"])


def run() -> None:
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("quantum_sandbox_mcp.api:app", host="0.0.0.0", port=port, reload=False)


if __name__ == "__main__":
    run()
