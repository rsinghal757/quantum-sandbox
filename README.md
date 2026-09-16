# quantum-sandbox

Production-ready Quantum Computer Sandbox for AI agents with:

- `quantum-sandbox-mcp`: Python MCP server package
- Qiskit Aer-only simulation (no real hardware execution)
- Shared SQLite job store under `QUANTUM_SANDBOX_DATA`
- Streamable HTTP MCP endpoint at `/mcp` (ChatGPT-compatible)
- Next.js jobs dashboard served at `/`
- Healthcheck endpoint at `/health`

## Architecture

Single-host routing:

- `GET /` -> Next.js dashboard (static export from `web/out`)
- `POST /mcp` -> Streamable HTTP MCP
- `GET /health` -> app health and data directory
- `GET /api/jobs` -> jobs history API
- `GET /api/jobs/{job_id}` -> rich job detail (derived visual fields)
- `GET /api/circuits` -> persisted circuits history
- `POST /api/circuits` -> persist a circuit from gates or QASM
- `POST /api/run` -> run shot-based simulation from circuit or draft payload
- `POST /api/statevector` -> run statevector simulation from circuit or draft payload
- `POST /api/circuit-model` -> parse circuit into editor-friendly layered model

MCP is also available over stdio with:

```bash
quantum-sandbox-mcp
```

## Data and persistence

All circuits and runs are stored in SQLite:

- Env var: `QUANTUM_SANDBOX_DATA`
- Default: `~/.quantum-sandbox`
- Production target: `/data`
- DB file: `jobs.sqlite3`

Every execution run (`run_circuit` and `simulate_statevector`) is persisted as a Job.

## MCP tools

Implemented tools:

- `list_backends`
- `create_circuit` (alias: `build_circuit`)
- `add_gates` (alias: `append_to_circuit`)
- `describe_circuit`
- `run_circuit`
- `get_job`
- `list_jobs`
- `simulate_statevector`
- `estimate`
- `explain_result`

Inputs support:

- structured gate lists (`[{"gate": ..., "qubits": [...]}, ...]`)
  - `targets` is still accepted as an alias for backward compatibility
  - for measurement gates, use `clbits` to map classical bits
- OpenQASM 2 and OpenQASM 3
  - Includes compatibility normalization for QASM payloads that emit lowercase `u(...)`
    by mapping to parser-supported equivalents (`u3(...)` for QASM2, `U(...)` for QASM3)

Defaults:

- backend: `aer_simulator`
- shots: `1024`

## Quantum Sandbox Studio (web)

The `/` web app is now **Quantum Sandbox Studio** with a Composer-style shell, still served
as static export from `web/out` by the Python host.

### Studio information architecture

1. **Left rail**: operations palette in a clean icon grid + searchable Jobs/Circuits history.
2. **Center**: editable circuit composer canvas with clear `q[i]`/`c[i]` wires, Qiskit-style CNOT
   and measurement glyphs, drag/drop placement, gate move/delete, param edit, and zoom controls.
3. **Right pane**: live synchronized code panel (OpenQASM, Qiskit sketch, structured gates JSON).
4. **Bottom zone**: side-by-side visualizations (histogram + probability table + Bloch vectors).
5. **Top bar**: primary **Set up and run** CTA with refresh, auto-refresh, and theme controls.

### Studio interaction loop

- Edit circuit in-memory on canvas.
- Click **Run** to call `POST /api/run` (same backend and job store as MCP).
- New job appears in left history; right drawer updates with latest results.
- Selecting a history job or persisted circuit rehydrates the editable canvas model.

## Quickstart (local)

### 1) Install dependencies

```bash
make install
make web-install
```

### 2) Run tests

```bash
make test
```

### 3) Build the dashboard

```bash
make web-build
```

### 4) Run the single-host API/dashboard process

```bash
PORT=8000 QUANTUM_SANDBOX_DATA=${QUANTUM_SANDBOX_DATA:-~/.quantum-sandbox} make run-api
```

Now open `http://localhost:8000`.

## ChatGPT Developer Mode MCP install

1. Deploy this service to a public HTTPS host.
2. In ChatGPT Developer Mode, add a new MCP server.
3. URL: `https://<host>/mcp`
4. Authentication: `None`
5. Save and connect.

CORS is enabled for MCP session/protocol headers to support browser-based MCP clients.
No OAuth is required; the service also exposes no-auth discovery metadata on common
`.well-known` OAuth/OpenID probe paths for connector compatibility.

## Cursor and Claude config examples

Under `configs/`:

- `configs/cursor-mcp.json` -> URL-based MCP configuration
- `configs/claude_desktop_config.json` -> stdio-based MCP configuration

Adjust `<host>` as needed.

## Railway deployment notes

This repo ships with:

- root `Dockerfile`
- `railway.toml`

Railway settings expectations:

- service listens on `$PORT`
- set `QUANTUM_SANDBOX_DATA=/data`
- mount a persistent volume at `/data`
- healthcheck at `/health`

## Development commands

```bash
make install        # Python package + dev dependencies
make web-install    # install Next.js dependencies
make web-build      # build web/out static export
make test           # run pytest suite
make run-api        # run API + MCP + dashboard on one host
make run-mcp        # stdio MCP server entrypoint
make docker-build   # build container image locally
```

## License

MIT. See `LICENSE`.
