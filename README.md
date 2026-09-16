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
- `GET /api/jobs` -> dashboard API for persisted jobs

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

## Dashboard (research console)

The `/` dashboard is a static-export Next.js research console served by the Python host.

### Shipped UX capabilities

- Dark-mode-first layout with persisted light/dark toggle
- Jobs table with search, status/backend filters, date range, and sorting
- Deep-linkable jobs (`/jobs/<job_id>`) with server-side index fallback
- Auto-refresh + manual refresh controls
- Circuit summary cards (qubits, clbits, depth, size, gate counts)
- Circuit visualization panel (Qiskit Playground–style interactive circuit canvas)
  - readable default gate spacing for deep circuits
  - per-gate colored chips, controls/targets, measurement links
  - horizontal + vertical pan/scroll
  - zoom in/out, fit-to-width, reset view
  - overview/detail mode toggle + layer scrubber for depth-heavy circuits
- Histogram charts for counts/probabilities with optional log-scale counts
- Side-by-side job comparison overlay + count-diff table
- Probability table, amplitude views (`|amp|^2` and real/imag), Bloch spheres
- OpenQASM syntax-highlighted viewer + copy
- Structured gate JSON and equivalent Qiskit sketch panels
- Metadata and input payload JSON panels
- Export selected job as JSON and counts as CSV

### Screenshot notes (what you should see)

1. **Jobs Observatory (top)**: metric strip + refresh/theme controls + advanced filters.
2. **Circuit Analysis (middle)**: summary cards and a full-height interactive circuit canvas
   with zoom controls and a layer scrubber.
3. **Measurement Analysis**: histogram/probability views and comparison diff table.
4. **State Analysis**: Bloch sphere cards per qubit and amplitude charts when available.
5. **Reproducibility**: OpenQASM + structured gates + Qiskit sketch + metadata JSON.

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
