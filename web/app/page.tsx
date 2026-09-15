'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

type Job = {
  id: string;
  kind: string;
  status: string;
  backend: string | null;
  shots: number | null;
  created_at: string;
  updated_at: string;
  error: string | null;
  input_payload: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  result_payload: Record<string, unknown> | null;
  circuit_qasm: string;
  derived?: DerivedPayload;
};

type DistributionRow = {
  basis_state: string;
  count: number | null;
  probability: number;
  log_count: number;
};

type CircuitOperation = {
  name: string;
  qubits: number[];
  clbits: number[];
  params: Array<number | string>;
};

type CircuitPayload = {
  num_qubits: number;
  num_clbits: number;
  depth: number;
  size: number;
  gate_counts: Record<string, number>;
  has_measurements: boolean;
  layers: CircuitOperation[][];
  operations: CircuitOperation[];
  structured_gates: Record<string, unknown>[];
  qiskit_python: string;
};

type AmplitudeRow = {
  basis_state: string;
  probability: number;
  real: number;
  imag: number;
};

type BlochVector = {
  qubit: number;
  x: number;
  y: number;
  z: number;
  purity: number;
};

type DerivedPayload = {
  duration_ms?: number | null;
  distribution?: DistributionRow[];
  circuit?: CircuitPayload;
  amplitudes?: AmplitudeRow[];
  bloch_vectors?: BlochVector[];
  bloch_unavailable_reason?: string;
  replay?: Record<string, unknown>;
  statevector_source?: string | null;
  circuit_error?: string;
};

type ThemeMode = 'dark' | 'light';
type SortField = 'created_at' | 'updated_at' | 'duration' | 'shots' | 'status' | 'kind';
type SortDirection = 'asc' | 'desc';
type ValueMode = 'counts' | 'probabilities';
type AmpMode = '|amp|^2' | 'real_imag';

const REFRESH_MS = 7000;
const MAX_CHART_STATES = 20;
const TOKEN_RE = /(->|"(?:[^"\\]|\\.)*"|\b[A-Za-z_][A-Za-z0-9_]*\b|\d+\.\d+|\d+|\S)/g;
const QASM_KEYWORDS = new Set(['OPENQASM', 'include', 'qubit', 'bit', 'qreg', 'creg', 'measure', 'barrier', 'gate', 'if']);
const QASM_GATES = new Set(['h', 'x', 'y', 'z', 'rx', 'ry', 'rz', 'u', 'u1', 'u2', 'u3', 'cx', 'cy', 'cz', 'swap', 'sx', 'cp', 'crx', 'cry', 'crz']);

const formatDateTime = (value?: string | null) => {
  if (!value) return 'n/a';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

const formatDuration = (durationMs?: number | null) => {
  if (!durationMs || durationMs <= 0) return '—';
  if (durationMs < 1000) return `${durationMs} ms`;
  const seconds = durationMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(1)}s`;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const copyText = async (value: string) => {
  await navigator.clipboard.writeText(value);
};

const downloadBlob = (content: string, filename: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const compareStates = (a: DistributionRow, b: DistributionRow) => {
  const aCount = a.count ?? 0;
  const bCount = b.count ?? 0;
  if (aCount !== bCount) return bCount - aCount;
  return b.probability - a.probability;
};

const pickTopStates = (
  primary: DistributionRow[],
  secondary: DistributionRow[] | null,
  maxStates: number,
) => {
  const stateMap = new Map<string, { a?: DistributionRow; b?: DistributionRow }>();

  for (const row of primary) {
    stateMap.set(row.basis_state, { ...(stateMap.get(row.basis_state) ?? {}), a: row });
  }

  for (const row of secondary ?? []) {
    stateMap.set(row.basis_state, { ...(stateMap.get(row.basis_state) ?? {}), b: row });
  }

  const merged = [...stateMap.entries()].map(([basis_state, values]) => {
    return {
      basis_state,
      a: values.a ?? { basis_state, count: 0, probability: 0, log_count: 0 },
      b: values.b ?? { basis_state, count: 0, probability: 0, log_count: 0 },
    };
  });

  merged.sort((left, right) => compareStates(left.a, right.a));
  return merged.slice(0, maxStates);
};

function HistogramChart({
  primary,
  secondary,
  title,
  mode,
  logScale,
}: {
  primary: DistributionRow[];
  secondary: DistributionRow[] | null;
  title: string;
  mode: ValueMode;
  logScale: boolean;
}) {
  const bars = useMemo(() => pickTopStates(primary, secondary, MAX_CHART_STATES), [primary, secondary]);

  const barWidth = secondary ? 20 : 36;
  const pairGap = 24;
  const chartHeight = 250;
  const chartWidth = Math.max(720, bars.length * (secondary ? 56 : 48));

  const getRawValue = (row: DistributionRow) => {
    if (mode === 'counts') return row.count ?? 0;
    return row.probability;
  };

  const transformValue = (value: number) => {
    if (logScale && mode === 'counts') {
      return Math.log10(value + 1);
    }
    return value;
  };

  const maxValue = bars.reduce((max, row) => {
    return Math.max(max, transformValue(getRawValue(row.a)), transformValue(getRawValue(row.b)));
  }, 0.00001);

  const yFor = (value: number) => chartHeight - (transformValue(value) / maxValue) * (chartHeight - 30);

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>{title}</h3>
        <p>{mode === 'counts' ? 'Counts' : 'Probabilities'} {logScale && mode === 'counts' ? '(log scale)' : ''}</p>
      </div>
      {bars.length === 0 ? (
        <p className="muted">No measurement distribution is available for this job.</p>
      ) : (
        <div className="chart-scroll">
          <svg className="histogram" viewBox={`0 0 ${chartWidth} ${chartHeight + 40}`} role="img" aria-label={title}>
            <line x1={20} y1={chartHeight} x2={chartWidth - 20} y2={chartHeight} className="axis" />
            {bars.map((row, index) => {
              const baseX = 28 + index * (barWidth * (secondary ? 2 : 1) + pairGap);
              const aValue = getRawValue(row.a);
              const bValue = getRawValue(row.b);
              const aY = yFor(aValue);
              const bY = yFor(bValue);
              return (
                <g key={row.basis_state}>
                  <rect x={baseX} y={aY} width={barWidth} height={chartHeight - aY} className="bar-primary" />
                  {secondary ? (
                    <rect
                      x={baseX + barWidth + 4}
                      y={bY}
                      width={barWidth}
                      height={chartHeight - bY}
                      className="bar-secondary"
                    />
                  ) : null}
                  <text x={baseX + barWidth} y={chartHeight + 16} textAnchor="middle" className="bar-label">
                    {row.basis_state}
                  </text>
                </g>
              );
            })}
          </svg>
          {secondary ? (
            <div className="legend-row">
              <span><i className="swatch primary" />Primary</span>
              <span><i className="swatch secondary" />Comparison</span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ProbabilityTable({ rows }: { rows: DistributionRow[] }) {
  const topRows = rows.slice(0, 24);
  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Probabilities Table</h3>
        <p>Top basis states</p>
      </div>
      {topRows.length === 0 ? (
        <p className="muted">No probability rows available.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Basis state</th>
              <th>Count</th>
              <th>Probability</th>
            </tr>
          </thead>
          <tbody>
            {topRows.map((row) => (
              <tr key={row.basis_state}>
                <td>{row.basis_state}</td>
                <td>{row.count ?? '—'}</td>
                <td>{(row.probability * 100).toFixed(3)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function BlochSphere({ vector }: { vector: BlochVector }) {
  const center = 72;
  const radius = 52;
  const x = clamp(vector.x, -1, 1);
  const y = clamp(vector.y, -1, 1);
  const z = clamp(vector.z, -1, 1);

  const endX = center + x * radius;
  const endY = center - z * radius;
  const hue = y >= 0 ? 190 : 340;

  return (
    <article className="bloch-card">
      <h4>q{vector.qubit}</h4>
      <svg viewBox="0 0 144 144" aria-label={`Bloch sphere for qubit ${vector.qubit}`}>
        <circle cx={center} cy={center} r={radius} className="bloch-sphere" />
        <ellipse cx={center} cy={center} rx={radius} ry={radius * 0.35} className="bloch-grid" />
        <line x1={center - radius} y1={center} x2={center + radius} y2={center} className="bloch-axis" />
        <line x1={center} y1={center - radius} x2={center} y2={center + radius} className="bloch-axis" />
        <line x1={center} y1={center} x2={endX} y2={endY} style={{ stroke: `hsl(${hue} 95% 62%)` }} className="bloch-vector" />
        <circle cx={endX} cy={endY} r={4} style={{ fill: `hsl(${hue} 95% 62%)` }} />
      </svg>
      <p>x={x.toFixed(3)} y={y.toFixed(3)} z={z.toFixed(3)}</p>
      <p>purity={vector.purity.toFixed(3)}</p>
    </article>
  );
}

function BlochPanel({ derived }: { derived?: DerivedPayload }) {
  const vectors = derived?.bloch_vectors ?? [];
  if (!vectors.length) {
    return (
      <section className="panel">
        <div className="panel-header">
          <h3>Bloch Spheres</h3>
          <p>Single-qubit reduced state vectors</p>
        </div>
        <div className="empty-state slim">
          <p>{derived?.bloch_unavailable_reason ?? 'Statevector data is required to render Bloch spheres.'}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Bloch Spheres</h3>
        <p>Source: {derived?.statevector_source ?? 'unknown'}</p>
      </div>
      <div className="bloch-grid-wrap">
        {vectors.map((vector) => (
          <BlochSphere key={vector.qubit} vector={vector} />
        ))}
      </div>
    </section>
  );
}

function AmplitudeChart({ amplitudes, mode }: { amplitudes: AmplitudeRow[]; mode: AmpMode }) {
  const rows = amplitudes.slice(0, 20);
  if (!rows.length) {
    return (
      <section className="panel">
        <div className="panel-header">
          <h3>Statevector Amplitudes</h3>
          <p>No amplitudes available</p>
        </div>
      </section>
    );
  }

  const width = Math.max(700, rows.length * 42 + 80);
  const height = 240;
  const normalize = (value: number, maxAbs: number) => 90 * (value / maxAbs);

  const maxAbs = rows.reduce((acc, row) => {
    if (mode === '|amp|^2') {
      return Math.max(acc, row.probability);
    }
    return Math.max(acc, Math.abs(row.real), Math.abs(row.imag));
  }, 0.0001);

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Statevector Amplitudes</h3>
        <p>Top {rows.length} basis states</p>
      </div>
      <div className="chart-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} className="amplitude-chart" aria-label="Amplitude chart">
          <line x1={40} y1={120} x2={width - 20} y2={120} className="axis" />
          {rows.map((row, index) => {
            const x = 50 + index * 36;
            if (mode === '|amp|^2') {
              const barHeight = (row.probability / maxAbs) * 90;
              return (
                <g key={row.basis_state}>
                  <rect x={x} y={120 - barHeight} width={20} height={barHeight} className="bar-primary" />
                  <text x={x + 10} y={140} textAnchor="middle" className="bar-label">{row.basis_state}</text>
                </g>
              );
            }

            const realHeight = normalize(row.real, maxAbs);
            const imagHeight = normalize(row.imag, maxAbs);
            return (
              <g key={row.basis_state}>
                <rect
                  x={x - 8}
                  y={120 - Math.max(realHeight, 0)}
                  width={10}
                  height={Math.abs(realHeight)}
                  className="bar-primary"
                />
                <rect
                  x={x + 4}
                  y={120 - Math.max(imagHeight, 0)}
                  width={10}
                  height={Math.abs(imagHeight)}
                  className="bar-secondary"
                />
                <text x={x + 2} y={140} textAnchor="middle" className="bar-label">{row.basis_state}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

function CircuitDiagram({ circuit }: { circuit?: CircuitPayload }) {
  if (!circuit) {
    return (
      <section className="panel">
        <div className="panel-header">
          <h3>Circuit Diagram</h3>
          <p>No circuit data</p>
        </div>
      </section>
    );
  }

  const layers = circuit.layers ?? [];
  const qRows = circuit.num_qubits;
  const cRows = circuit.num_clbits;
  const rowHeight = 42;
  const laneGap = 18;
  const colWidth = 86;
  const leftPad = 80;
  const topPad = 40;
  const wireRows = qRows + cRows;
  const chartHeight = topPad + wireRows * rowHeight + laneGap;
  const chartWidth = Math.max(740, leftPad + layers.length * colWidth + 64);

  const yForQubit = (index: number) => topPad + index * rowHeight;
  const yForClbit = (index: number) => topPad + qRows * rowHeight + laneGap + index * rowHeight;

  return (
    <section className="panel">
      <div className="panel-header">
        <h3>Circuit Diagram</h3>
        <p>{layers.length} layered columns · depth {circuit.depth}</p>
      </div>
      <div className="chart-scroll">
        <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="circuit-diagram" aria-label="Quantum circuit diagram">
          {Array.from({ length: qRows }).map((_, index) => (
            <g key={`q-${index}`}>
              <line x1={leftPad - 20} y1={yForQubit(index)} x2={chartWidth - 20} y2={yForQubit(index)} className="wire" />
              <text x={12} y={yForQubit(index) + 4} className="wire-label">q{index}</text>
            </g>
          ))}
          {Array.from({ length: cRows }).map((_, index) => (
            <g key={`c-${index}`}>
              <line x1={leftPad - 20} y1={yForClbit(index)} x2={chartWidth - 20} y2={yForClbit(index)} className="wire classical" />
              <text x={12} y={yForClbit(index) + 4} className="wire-label">c{index}</text>
            </g>
          ))}

          {layers.map((layer, layerIndex) => {
            const x = leftPad + layerIndex * colWidth;
            return (
              <g key={`layer-${layerIndex}`}>
                {layer.map((operation, opIndex) => {
                  const qubitYs = operation.qubits.map(yForQubit);
                  const clbitYs = operation.clbits.map(yForClbit);
                  const allYs = [...qubitYs, ...clbitYs];
                  const minY = Math.min(...allYs);
                  const maxY = Math.max(...allYs);
                  const gateLabel = operation.name.toUpperCase();

                  return (
                    <g key={`${layerIndex}-${opIndex}`}>
                      {allYs.length > 1 ? (
                        <line x1={x} y1={minY} x2={x} y2={maxY} className="gate-link" />
                      ) : null}

                      {operation.qubits.map((qubit, qubitIndex) => {
                        const y = yForQubit(qubit);
                        if (operation.name === 'measure' && operation.clbits[qubitIndex] !== undefined) {
                          const targetY = yForClbit(operation.clbits[qubitIndex]);
                          return (
                            <g key={`m-${qubit}-${qubitIndex}`}>
                              <rect x={x - 16} y={y - 14} width={32} height={28} rx={6} className="gate-box measurement" />
                              <text x={x} y={y + 5} textAnchor="middle" className="gate-text">M</text>
                              <line x1={x + 16} y1={y} x2={x + 28} y2={targetY} className="measure-line" />
                            </g>
                          );
                        }
                        return (
                          <g key={`q-${qubit}-${qubitIndex}`}>
                            <rect x={x - 18} y={y - 14} width={36} height={28} rx={6} className="gate-box" />
                            <text x={x} y={y + 5} textAnchor="middle" className="gate-text">{gateLabel}</text>
                          </g>
                        );
                      })}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

function CircuitSummaryCards({ circuit }: { circuit?: CircuitPayload }) {
  if (!circuit) return null;

  const gateSummary = Object.entries(circuit.gate_counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);

  return (
    <section className="summary-grid">
      <article className="summary-card"><span>Qubits</span><strong>{circuit.num_qubits}</strong></article>
      <article className="summary-card"><span>Clbits</span><strong>{circuit.num_clbits}</strong></article>
      <article className="summary-card"><span>Depth</span><strong>{circuit.depth}</strong></article>
      <article className="summary-card"><span>Size</span><strong>{circuit.size}</strong></article>
      <article className="summary-card wide">
        <span>Gate counts</span>
        <strong>{gateSummary.map(([gate, count]) => `${gate}:${count}`).join(' · ') || 'n/a'}</strong>
      </article>
    </section>
  );
}

function renderHighlightedLine(line: string, lineNumber: number) {
  const commentIndex = line.indexOf('//');
  const codePart = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const commentPart = commentIndex >= 0 ? line.slice(commentIndex) : '';

  const codeTokens: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;

  while ((match = TOKEN_RE.exec(codePart)) !== null) {
    if (match.index > cursor) {
      codeTokens.push(<span key={`${lineNumber}-plain-${cursor}`}>{codePart.slice(cursor, match.index)}</span>);
    }
    const token = match[0];
    let className = 'token plain';
    if (QASM_KEYWORDS.has(token)) className = 'token keyword';
    else if (QASM_GATES.has(token)) className = 'token gate';
    else if (/^".*"$/.test(token)) className = 'token string';
    else if (/^(\d+\.\d+|\d+)$/.test(token) || token === 'pi') className = 'token number';
    else if (/^[{}()[\];,]|->$/.test(token)) className = 'token punct';
    codeTokens.push(
      <span key={`${lineNumber}-tok-${match.index}`} className={className}>
        {token}
      </span>,
    );
    cursor = match.index + token.length;
  }

  if (cursor < codePart.length) {
    codeTokens.push(<span key={`${lineNumber}-tail`}>{codePart.slice(cursor)}</span>);
  }

  return (
    <div key={`line-${lineNumber}`} className="code-line">
      <span className="line-number">{lineNumber}</span>
      <span className="line-content">
        {codeTokens}
        {commentPart ? <span className="token comment">{commentPart}</span> : null}
      </span>
    </div>
  );
}

function CodePanel({ title, code, language }: { title: string; code: string; language: 'qasm' | 'json' | 'python' }) {
  const lines = code.split('\n');
  return (
    <section className="panel">
      <div className="panel-header inline-controls">
        <div>
          <h3>{title}</h3>
          <p>{language.toUpperCase()}</p>
        </div>
        <button type="button" onClick={() => copyText(code)} className="ghost-button">Copy</button>
      </div>
      <div className="code-viewer" role="region" aria-label={`${title} code viewer`}>
        {language === 'qasm' ? lines.map((line, index) => renderHighlightedLine(line, index + 1)) : null}
        {language !== 'qasm'
          ? lines.map((line, index) => (
              <div key={`line-${index + 1}`} className="code-line">
                <span className="line-number">{index + 1}</span>
                <span className="line-content monospace">{line || ' '}</span>
              </div>
            ))
          : null}
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status}`}>{status}</span>;
}

export default function HomePage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [compareJobId, setCompareJobId] = useState<string>('');
  const [jobCache, setJobCache] = useState<Record<string, Job>>({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [backendFilter, setBackendFilter] = useState('all');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [sortField, setSortField] = useState<SortField>('created_at');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [valueMode, setValueMode] = useState<ValueMode>('counts');
  const [logScale, setLogScale] = useState(false);
  const [ampMode, setAmpMode] = useState<AmpMode>('|amp|^2');

  const selectedJob = selectedJobId ? jobCache[selectedJobId] ?? null : null;
  const compareJob = compareJobId ? jobCache[compareJobId] ?? null : null;

  useEffect(() => {
    const stored = window.localStorage.getItem('quantum-dashboard-theme');
    if (stored === 'dark' || stored === 'light') {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    } else {
      document.documentElement.dataset.theme = 'dark';
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('quantum-dashboard-theme', theme);
  }, [theme]);

  const parseJobIdFromPath = useCallback(() => {
    const match = window.location.pathname.match(/^\/jobs\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  }, []);

  useEffect(() => {
    const syncFromPath = () => {
      const pathJobId = parseJobIdFromPath();
      if (pathJobId) {
        setSelectedJobId(pathJobId);
      }
    };

    syncFromPath();
    window.addEventListener('popstate', syncFromPath);
    return () => window.removeEventListener('popstate', syncFromPath);
  }, [parseJobIdFromPath]);

  const fetchJobDetail = useCallback(async (jobId: string, force = false) => {
    if (!force && jobCache[jobId]) {
      return jobCache[jobId];
    }

    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch job ${jobId} (${response.status})`);
    }
    const payload = (await response.json()) as Job;
    setJobCache((previous) => ({ ...previous, [jobId]: payload }));
    return payload;
  }, [jobCache]);

  const fetchJobs = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const response = await fetch('/api/jobs?limit=200');
      if (!response.ok) {
        throw new Error(`Failed to load jobs (${response.status})`);
      }
      const payload = (await response.json()) as { jobs: Job[] };
      setJobs(payload.jobs ?? []);
      setJobCache((previous) => {
        const merged = { ...previous };
        for (const job of payload.jobs ?? []) {
          merged[job.id] = { ...merged[job.id], ...job };
        }
        return merged;
      });
      setLastRefreshedAt(new Date());

      if (!selectedJobId && payload.jobs.length > 0) {
        const initialId = parseJobIdFromPath() ?? payload.jobs[0].id;
        setSelectedJobId(initialId);
      }
    } catch (unknownError) {
      setError(unknownError instanceof Error ? unknownError.message : 'Unexpected dashboard failure');
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [parseJobIdFromPath, selectedJobId]);

  useEffect(() => {
    void fetchJobs(false);
  }, [fetchJobs]);

  useEffect(() => {
    if (!autoRefresh) return;
    const intervalId = window.setInterval(() => {
      void fetchJobs(true);
    }, REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [autoRefresh, fetchJobs]);

  useEffect(() => {
    if (!selectedJobId) return;
    setLoadingDetails(true);
    fetchJobDetail(selectedJobId)
      .catch((unknownError) => {
        setError(unknownError instanceof Error ? unknownError.message : 'Failed to load selected job details');
      })
      .finally(() => setLoadingDetails(false));
  }, [selectedJobId, fetchJobDetail]);

  useEffect(() => {
    if (!compareJobId) return;
    fetchJobDetail(compareJobId).catch((unknownError) => {
      setError(unknownError instanceof Error ? unknownError.message : 'Failed to load comparison job');
    });
  }, [compareJobId, fetchJobDetail]);

  const statusCounts = useMemo(() => {
    return jobs.reduce<Record<string, number>>((accumulator, job) => {
      accumulator[job.status] = (accumulator[job.status] ?? 0) + 1;
      return accumulator;
    }, {});
  }, [jobs]);

  const backendOptions = useMemo(() => {
    const unique = new Set<string>();
    jobs.forEach((job) => {
      if (job.backend) unique.add(job.backend);
    });
    return [...unique].sort();
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    const startsAt = dateStart ? new Date(`${dateStart}T00:00:00Z`).getTime() : null;
    const endsAt = dateEnd ? new Date(`${dateEnd}T23:59:59Z`).getTime() : null;

    const visible = jobs.filter((job) => {
      if (statusFilter !== 'all' && job.status !== statusFilter) return false;
      if (backendFilter !== 'all' && job.backend !== backendFilter) return false;

      if (search.trim()) {
        const haystack = [job.id, job.kind, job.status, job.backend ?? '', job.error ?? '', JSON.stringify(job.metadata ?? {}), JSON.stringify(job.input_payload ?? {})]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(search.toLowerCase())) {
          return false;
        }
      }

      const createdAt = new Date(job.created_at).getTime();
      if (startsAt && !Number.isNaN(createdAt) && createdAt < startsAt) return false;
      if (endsAt && !Number.isNaN(createdAt) && createdAt > endsAt) return false;
      return true;
    });

    const direction = sortDirection === 'asc' ? 1 : -1;

    return visible.sort((left, right) => {
      const leftDuration = left.derived?.duration_ms ?? 0;
      const rightDuration = right.derived?.duration_ms ?? 0;

      if (sortField === 'shots') {
        return direction * ((left.shots ?? 0) - (right.shots ?? 0));
      }
      if (sortField === 'duration') {
        return direction * (leftDuration - rightDuration);
      }
      if (sortField === 'status') {
        return direction * left.status.localeCompare(right.status);
      }
      if (sortField === 'kind') {
        return direction * left.kind.localeCompare(right.kind);
      }
      if (sortField === 'updated_at') {
        return direction * (new Date(left.updated_at).getTime() - new Date(right.updated_at).getTime());
      }
      return direction * (new Date(left.created_at).getTime() - new Date(right.created_at).getTime());
    });
  }, [jobs, statusFilter, backendFilter, search, dateStart, dateEnd, sortDirection, sortField]);

  const selectJob = useCallback((jobId: string) => {
    setSelectedJobId(jobId);
    window.history.replaceState({}, '', `/jobs/${encodeURIComponent(jobId)}`);
  }, []);

  const distribution = selectedJob?.derived?.distribution ?? [];
  const compareDistribution = compareJob?.derived?.distribution ?? null;
  const circuit = selectedJob?.derived?.circuit;
  const amplitudes = selectedJob?.derived?.amplitudes ?? [];

  const replaySummary = selectedJob?.derived?.replay ?? null;

  const exportJobJson = () => {
    if (!selectedJob) return;
    downloadBlob(JSON.stringify(selectedJob, null, 2), `job-${selectedJob.id}.json`, 'application/json');
  };

  const exportCountsCsv = () => {
    if (!selectedJob) return;
    const rows = selectedJob.derived?.distribution ?? [];
    const lines = ['basis_state,count,probability'];
    rows.forEach((row) => {
      lines.push(`${row.basis_state},${row.count ?? ''},${row.probability}`);
    });
    downloadBlob(lines.join('\n'), `job-${selectedJob.id}-counts.csv`, 'text/csv');
  };

  const compareStateRows = useMemo(() => {
    if (!distribution.length || !compareDistribution?.length) return [];
    const merged = pickTopStates(distribution, compareDistribution, 16);
    return merged.map((row) => ({
      basis_state: row.basis_state,
      primary: row.a.count ?? 0,
      secondary: row.b.count ?? 0,
      diff: (row.a.count ?? 0) - (row.b.count ?? 0),
    }));
  }, [distribution, compareDistribution]);

  return (
    <main className="console-root">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Quantum Sandbox · Research Console</p>
          <h1>Jobs Observatory</h1>
          <p className="muted">MCP and API-compatible console for simulation jobs, circuit diagnostics, and state analysis.</p>
        </div>
        <div className="top-actions">
          <button type="button" className="ghost-button" onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}>
            {theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          </button>
          <button type="button" className="ghost-button" onClick={() => void fetchJobs(false)}>
            Refresh now
          </button>
          <label className="toggle">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            Auto refresh
          </label>
          <small>Last sync: {lastRefreshedAt ? lastRefreshedAt.toLocaleTimeString() : 'never'}</small>
        </div>
      </header>

      <section className="metric-strip">
        <article><span>Total jobs</span><strong>{jobs.length}</strong></article>
        <article><span>Completed</span><strong>{statusCounts.completed ?? 0}</strong></article>
        <article><span>Running</span><strong>{statusCounts.running ?? 0}</strong></article>
        <article><span>Failed</span><strong>{statusCounts.failed ?? 0}</strong></article>
      </section>

      <section className="filters panel">
        <div className="filters-grid">
          <label>
            Search
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="job id, kind, metadata, error..." />
          </label>
          <label>
            Status
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All</option>
              <option value="completed">Completed</option>
              <option value="running">Running</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label>
            Backend
            <select value={backendFilter} onChange={(event) => setBackendFilter(event.target.value)}>
              <option value="all">All backends</option>
              {backendOptions.map((backend) => (
                <option key={backend} value={backend}>{backend}</option>
              ))}
            </select>
          </label>
          <label>
            Date start
            <input type="date" value={dateStart} onChange={(event) => setDateStart(event.target.value)} />
          </label>
          <label>
            Date end
            <input type="date" value={dateEnd} onChange={(event) => setDateEnd(event.target.value)} />
          </label>
          <label>
            Sort
            <select value={sortField} onChange={(event) => setSortField(event.target.value as SortField)}>
              <option value="created_at">Created at</option>
              <option value="updated_at">Updated at</option>
              <option value="duration">Duration</option>
              <option value="shots">Shots</option>
              <option value="status">Status</option>
              <option value="kind">Kind</option>
            </select>
          </label>
          <label>
            Direction
            <select value={sortDirection} onChange={(event) => setSortDirection(event.target.value as SortDirection)}>
              <option value="desc">Descending</option>
              <option value="asc">Ascending</option>
            </select>
          </label>
        </div>
      </section>

      {error ? <section className="panel error-panel">{error}</section> : null}
      {loading ? <section className="panel loading-panel">Loading research jobs…</section> : null}
      {!loading && filteredJobs.length === 0 ? (
        <section className="panel empty-state">
          <h2>No jobs match current filters</h2>
          <p>Run circuits through MCP or adjust filters to populate this console.</p>
        </section>
      ) : null}

      <section className="workspace-layout">
        <section className="panel jobs-panel" aria-label="Jobs list">
          <div className="panel-header inline-controls">
            <div>
              <h2>Jobs</h2>
              <p>{filteredJobs.length} shown / {jobs.length} total</p>
            </div>
            <div className="panel-actions">
              <button type="button" className="ghost-button" onClick={exportJobJson} disabled={!selectedJob}>Export JSON</button>
              <button type="button" className="ghost-button" onClick={exportCountsCsv} disabled={!selectedJob}>Export counts CSV</button>
            </div>
          </div>

          <div className="jobs-list" role="listbox" aria-label="Simulation jobs">
            {filteredJobs.map((job) => {
              const active = job.id === selectedJobId;
              return (
                <button
                  key={job.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`job-row ${active ? 'active' : ''}`}
                  onClick={() => selectJob(job.id)}
                >
                  <div>
                    <strong>{job.kind}</strong>
                    <p>{job.id}</p>
                  </div>
                  <div>
                    <StatusBadge status={job.status} />
                    <small>{formatDateTime(job.created_at)}</small>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="detail-stack">
          <section className="panel">
            <div className="panel-header inline-controls">
              <div>
                <h2>Job details</h2>
                <p>{selectedJob ? selectedJob.id : 'Select a job'}</p>
              </div>
              <div className="panel-actions">
                <button type="button" className="ghost-button" onClick={() => selectedJob && copyText(selectedJob.id)} disabled={!selectedJob}>Copy job id</button>
                <button type="button" className="ghost-button" onClick={() => selectedJob && copyText(selectedJob.circuit_qasm)} disabled={!selectedJob}>Copy QASM</button>
              </div>
            </div>
            {loadingDetails ? <p className="muted">Loading selected job detail…</p> : null}
            {!selectedJob ? <p className="muted">Choose a job to inspect detailed artifacts.</p> : null}
            {selectedJob ? (
              <div className="detail-meta-grid">
                <article>
                  <span>Status</span>
                  <StatusBadge status={selectedJob.status} />
                </article>
                <article>
                  <span>Backend</span>
                  <strong>{selectedJob.backend ?? 'n/a'}</strong>
                </article>
                <article>
                  <span>Shots</span>
                  <strong>{selectedJob.shots ?? 'n/a'}</strong>
                </article>
                <article>
                  <span>Created</span>
                  <strong>{formatDateTime(selectedJob.created_at)}</strong>
                </article>
                <article>
                  <span>Updated</span>
                  <strong>{formatDateTime(selectedJob.updated_at)}</strong>
                </article>
                <article>
                  <span>Duration</span>
                  <strong>{formatDuration(selectedJob.derived?.duration_ms)}</strong>
                </article>
              </div>
            ) : null}

            {selectedJob?.error ? <p className="error-inline">Execution error: {selectedJob.error}</p> : null}

            <div className="compare-controls">
              <label>
                Compare against
                <select value={compareJobId} onChange={(event) => setCompareJobId(event.target.value)}>
                  <option value="">No comparison</option>
                  {jobs
                    .filter((job) => job.id !== selectedJobId)
                    .map((job) => (
                      <option key={job.id} value={job.id}>{job.kind} · {job.id.slice(0, 8)}</option>
                    ))}
                </select>
              </label>

              <label>
                Chart mode
                <select value={valueMode} onChange={(event) => setValueMode(event.target.value as ValueMode)}>
                  <option value="counts">Counts</option>
                  <option value="probabilities">Probabilities</option>
                </select>
              </label>

              <label className="toggle compact">
                <input type="checkbox" checked={logScale} onChange={(event) => setLogScale(event.target.checked)} />
                Log-scale histogram
              </label>
            </div>
          </section>

          <CircuitSummaryCards circuit={circuit} />
          <CircuitDiagram circuit={circuit} />

          <HistogramChart
            title={compareJob ? 'Measurement Histogram (comparison overlay)' : 'Measurement Histogram'}
            primary={distribution}
            secondary={compareDistribution}
            mode={valueMode}
            logScale={logScale}
          />

          {compareStateRows.length > 0 ? (
            <section className="panel">
              <div className="panel-header">
                <h3>Job compare diff</h3>
                <p>Primary minus comparison counts</p>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Basis state</th>
                    <th>Primary</th>
                    <th>Comparison</th>
                    <th>Diff</th>
                  </tr>
                </thead>
                <tbody>
                  {compareStateRows.map((row) => (
                    <tr key={row.basis_state}>
                      <td>{row.basis_state}</td>
                      <td>{row.primary}</td>
                      <td>{row.secondary}</td>
                      <td>{row.diff >= 0 ? `+${row.diff}` : row.diff}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          <ProbabilityTable rows={distribution} />

          <section className="panel">
            <div className="panel-header inline-controls">
              <div>
                <h3>Amplitude view</h3>
                <p>Inspect statevector amplitudes when available</p>
              </div>
              <label>
                Mode
                <select value={ampMode} onChange={(event) => setAmpMode(event.target.value as AmpMode)}>
                  <option value="|amp|^2">Magnitude |amp|²</option>
                  <option value="real_imag">Real / Imag</option>
                </select>
              </label>
            </div>
            <AmplitudeChart amplitudes={amplitudes} mode={ampMode} />
          </section>

          <BlochPanel derived={selectedJob?.derived} />

          {replaySummary ? (
            <section className="panel">
              <div className="panel-header">
                <h3>Replay summary</h3>
                <p>Algorithm-focused metadata for reproducibility</p>
              </div>
              <pre className="json-block">{JSON.stringify(replaySummary, null, 2)}</pre>
            </section>
          ) : null}

          <CodePanel title="OpenQASM" code={selectedJob?.circuit_qasm ?? ''} language="qasm" />

          <CodePanel
            title="Structured gate JSON"
            code={JSON.stringify(circuit?.structured_gates ?? [], null, 2)}
            language="json"
          />

          <CodePanel
            title="Equivalent Qiskit sketch"
            code={circuit?.qiskit_python ?? 'from qiskit import QuantumCircuit\n# Circuit data unavailable'}
            language="python"
          />

          <section className="panel">
            <div className="panel-header">
              <h3>Metadata JSON</h3>
              <p>Input payload and run metadata</p>
            </div>
            <div className="split-json">
              <article>
                <h4>Metadata</h4>
                <pre className="json-block">{JSON.stringify(selectedJob?.metadata ?? {}, null, 2)}</pre>
              </article>
              <article>
                <h4>Input payload</h4>
                <pre className="json-block">{JSON.stringify(selectedJob?.input_payload ?? {}, null, 2)}</pre>
              </article>
            </div>
          </section>
        </section>
      </section>
    </main>
  );
}
