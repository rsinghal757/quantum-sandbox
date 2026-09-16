'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

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
const CONTROLLED_GATES = new Set(['cx', 'cy', 'cz', 'ch', 'cp', 'crx', 'cry', 'crz']);
const PARAMETERIZED_GATES = new Set(['rx', 'ry', 'rz', 'p', 'u', 'u1', 'u2', 'u3', 'cp', 'crx', 'cry', 'crz']);

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
    <section className="panel panel-chart">
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
    <section className="panel panel-table">
      <div className="panel-header">
        <h3>Probabilities Table</h3>
        <p>Top basis states</p>
      </div>
      {topRows.length === 0 ? (
        <p className="muted">No probability rows available.</p>
      ) : (
        <div className="table-scroll">
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
        </div>
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
      <section className="panel panel-bloch">
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
    <section className="panel panel-bloch">
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
    return <p className="muted">No amplitudes available for this job.</p>;
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
    <>
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
    </>
  );
}

const gateChipColor = (gateName: string): string => {
  if (gateName === 'measure') return '#f59e0b';
  if (gateName === 'swap') return '#f97316';
  if (gateName === 'barrier') return '#64748b';
  if (CONTROLLED_GATES.has(gateName) || gateName === 'ccx') return '#34d399';
  if (gateName === 'h' || gateName === 'sx') return '#22d3ee';
  if (['x', 'y', 'z'].includes(gateName)) return '#60a5fa';
  if (['s', 'sdg', 't', 'tdg'].includes(gateName)) return '#a78bfa';
  if (PARAMETERIZED_GATES.has(gateName)) return '#fb7185';
  return '#94a3b8';
};

const gateLabel = (operation: CircuitOperation): { main: string; sub: string | null } => {
  const gateName = operation.name.toLowerCase();
  const main = gateName.toUpperCase();
  if (!PARAMETERIZED_GATES.has(gateName) || operation.params.length === 0) {
    return { main, sub: null };
  }
  const firstParam = operation.params[0];
  const rendered = typeof firstParam === 'number' ? firstParam.toFixed(2) : String(firstParam);
  return { main, sub: rendered.length > 9 ? `${rendered.slice(0, 9)}…` : rendered };
};

function CircuitDiagram({ circuit }: { circuit?: CircuitPayload }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewMode, setViewMode] = useState<'detail' | 'overview'>('detail');
  const [viewportState, setViewportState] = useState({ width: 900, height: 560, scrollLeft: 0, scrollTop: 0 });

  const minZoom = viewMode === 'detail' ? 0.45 : 0.25;
  const maxZoom = viewMode === 'detail' ? 2.5 : 1.4;

  useEffect(() => {
    setZoom((previous) => clamp(previous, minZoom, maxZoom));
  }, [minZoom, maxZoom]);

  const layers = circuit?.layers ?? [];
  const qRows = circuit?.num_qubits ?? 0;
  const cRows = circuit?.num_clbits ?? 0;

  const metrics = useMemo(() => {
    const detail = viewMode === 'detail';
    const rowGap = detail ? 62 : 36;
    const colWidth = detail ? 78 : 40;
    const gateWidth = detail ? 42 : 22;
    const gateHeight = detail ? 36 : 18;
    const topPad = detail ? 56 : 36;
    const leftPad = detail ? 106 : 82;
    const classicalGap = detail ? 52 : 26;
    const bottomPad = detail ? 42 : 24;
    const contentWidth = Math.max(920, leftPad + layers.length * colWidth + 80);
    const contentHeight =
      topPad +
      Math.max(qRows - 1, 0) * rowGap +
      (cRows > 0 ? classicalGap + Math.max(cRows - 1, 0) * rowGap : 0) +
      bottomPad;
    return {
      detail,
      rowGap,
      colWidth,
      gateWidth,
      gateHeight,
      topPad,
      leftPad,
      classicalGap,
      bottomPad,
      contentWidth,
      contentHeight,
      fontSize: detail ? 10 : 8,
      subFontSize: detail ? 8 : 0,
    };
  }, [cRows, layers.length, qRows, viewMode]);

  const yForQubit = useCallback(
    (index: number) => metrics.topPad + index * metrics.rowGap,
    [metrics.rowGap, metrics.topPad],
  );
  const yForClbit = useCallback(
    (index: number) =>
      metrics.topPad + Math.max(qRows - 1, 0) * metrics.rowGap + metrics.classicalGap + index * metrics.rowGap,
    [metrics.classicalGap, metrics.rowGap, metrics.topPad, qRows],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;

    const update = () => {
      setViewportState({
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scrollLeft: viewport.scrollLeft,
        scrollTop: viewport.scrollTop,
      });
    };

    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [metrics.contentWidth, metrics.contentHeight]);

  const onViewportScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setViewportState((previous) => ({
      ...previous,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    }));
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ left: 0, top: 0 });
  }, [circuit?.depth, circuit?.num_qubits, circuit?.num_clbits]);

  const columnPixels = metrics.colWidth * zoom;
  const visibleStart = Math.max(0, Math.floor(viewportState.scrollLeft / columnPixels) - 2);
  const visibleEnd = Math.min(
    Math.max(layers.length - 1, 0),
    Math.ceil((viewportState.scrollLeft + viewportState.width) / columnPixels) + 2,
  );
  const layerIndices = useMemo(() => {
    if (layers.length === 0) return [];
    return Array.from({ length: visibleEnd - visibleStart + 1 }, (_, index) => visibleStart + index);
  }, [layers.length, visibleEnd, visibleStart]);

  const zoomIn = () => setZoom((previous) => clamp(previous * 1.2, minZoom, maxZoom));
  const zoomOut = () => setZoom((previous) => clamp(previous / 1.2, minZoom, maxZoom));
  const resetView = () => {
    setZoom(1);
    const viewport = viewportRef.current;
    viewport?.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  };
  const fitToWidth = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const available = Math.max(viewport.clientWidth - 28, 300);
    const fitted = clamp(available / metrics.contentWidth, minZoom, maxZoom);
    setZoom(fitted);
    viewport.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
  };

  const scrubberMax = Math.max(layers.length - 1, 0);
  const scrubberValue = scrubberMax === 0 ? 0 : Math.min(scrubberMax, Math.round(viewportState.scrollLeft / columnPixels));
  const onScrubberChange = (value: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ left: value * columnPixels, behavior: 'auto' });
  };

  const onViewportKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const horizontalStep = columnPixels * 2;
    const verticalStep = metrics.rowGap * zoom * 1.5;
    if (event.key === 'ArrowRight') {
      viewport.scrollBy({ left: horizontalStep, behavior: 'smooth' });
      event.preventDefault();
    } else if (event.key === 'ArrowLeft') {
      viewport.scrollBy({ left: -horizontalStep, behavior: 'smooth' });
      event.preventDefault();
    } else if (event.key === 'ArrowDown') {
      viewport.scrollBy({ top: verticalStep, behavior: 'smooth' });
      event.preventDefault();
    } else if (event.key === 'ArrowUp') {
      viewport.scrollBy({ top: -verticalStep, behavior: 'smooth' });
      event.preventDefault();
    }
  };

  if (!circuit) {
    return (
      <section className="panel panel-circuit">
        <div className="panel-header">
          <h3>Circuit Diagram</h3>
          <p>No circuit data</p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel panel-circuit">
      <div className="panel-header circuit-header">
        <div>
          <h3>Circuit Canvas</h3>
          <p>
            {layers.length} layers · depth {circuit.depth} · zoom {(zoom * 100).toFixed(0)}%
          </p>
        </div>
        <div className="circuit-controls">
          <button type="button" className="ghost-button" onClick={zoomOut} aria-label="Zoom out">
            −
          </button>
          <button type="button" className="ghost-button" onClick={zoomIn} aria-label="Zoom in">
            +
          </button>
          <button type="button" className="ghost-button" onClick={fitToWidth}>
            Fit width
          </button>
          <button type="button" className="ghost-button" onClick={resetView}>
            Reset
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => setViewMode((previous) => (previous === 'detail' ? 'overview' : 'detail'))}
          >
            {viewMode === 'detail' ? 'Overview mode' : 'Detail mode'}
          </button>
        </div>
      </div>

      <div className="circuit-status-row">
        <p>
          Rendering layers <strong>{visibleStart + 1}</strong>–<strong>{visibleEnd + 1}</strong> of{' '}
          <strong>{layers.length}</strong>
        </p>
        <p>Use mouse/trackpad scroll, drag scrollbar, or arrow keys to pan.</p>
      </div>

      {scrubberMax > 0 ? (
        <label className="circuit-scrubber">
          Layer scrubber
          <input
            type="range"
            min={0}
            max={scrubberMax}
            value={scrubberValue}
            onChange={(event) => onScrubberChange(Number(event.target.value))}
          />
        </label>
      ) : null}

      <div
        ref={viewportRef}
        className="circuit-viewport"
        onScroll={onViewportScroll}
        onKeyDown={onViewportKeyDown}
        tabIndex={0}
        aria-label="Interactive circuit canvas. Use arrow keys to pan."
      >
        <svg
          width={Math.ceil(metrics.contentWidth * zoom)}
          height={Math.ceil(metrics.contentHeight * zoom)}
          viewBox={`0 0 ${metrics.contentWidth} ${metrics.contentHeight}`}
          className="circuit-canvas"
          role="img"
          aria-label="Interactive quantum circuit diagram"
        >
          {Array.from({ length: qRows }).map((_, index) => (
            <g key={`q-${index}`}>
              <line
                x1={metrics.leftPad - 16}
                y1={yForQubit(index)}
                x2={metrics.contentWidth - 20}
                y2={yForQubit(index)}
                className="wire"
              />
              <text x={14} y={yForQubit(index) + 4} className="wire-label">
                q{index}
              </text>
            </g>
          ))}

          {Array.from({ length: cRows }).map((_, index) => (
            <g key={`c-${index}`}>
              <line
                x1={metrics.leftPad - 16}
                y1={yForClbit(index)}
                x2={metrics.contentWidth - 20}
                y2={yForClbit(index)}
                className="wire classical"
              />
              <text x={14} y={yForClbit(index) + 4} className="wire-label">
                c{index}
              </text>
            </g>
          ))}

          {layerIndices.map((layerIndex) => {
            const layer = layers[layerIndex];
            const x = metrics.leftPad + layerIndex * metrics.colWidth + metrics.colWidth * 0.5;
            return (
              <g key={`layer-${layerIndex}`}>
                {layer.map((operation, operationIndex) => {
                  const gateName = operation.name.toLowerCase();
                  const chipColor = gateChipColor(gateName);
                  const chipStyle = { '--chip-color': chipColor } as CSSProperties;
                  const { main, sub } = gateLabel(operation);
                  const qubitYs = operation.qubits.map(yForQubit);
                  const clbitYs = operation.clbits.map(yForClbit);
                  const allYs = [...qubitYs, ...clbitYs];
                  const minY = allYs.length ? Math.min(...allYs) : 0;
                  const maxY = allYs.length ? Math.max(...allYs) : 0;

                  if (gateName === 'barrier') {
                    const barrierMin = qubitYs.length ? Math.min(...qubitYs) : yForQubit(0);
                    const barrierMax = qubitYs.length ? Math.max(...qubitYs) : yForQubit(Math.max(qRows - 1, 0));
                    return (
                      <g key={`${layerIndex}-barrier-${operationIndex}`}>
                        <line
                          x1={x}
                          y1={barrierMin - metrics.gateHeight * 0.6}
                          x2={x}
                          y2={barrierMax + metrics.gateHeight * 0.6}
                          className="barrier-line"
                        />
                      </g>
                    );
                  }

                  if (gateName === 'measure') {
                    return (
                      <g key={`${layerIndex}-measure-${operationIndex}`}>
                        {operation.qubits.map((qubit, index) => {
                          const qubitY = yForQubit(qubit);
                          const clbit = operation.clbits[index];
                          const clbitY = clbit !== undefined ? yForClbit(clbit) : null;
                          return (
                            <g key={`${layerIndex}-measure-${qubit}-${index}`} style={chipStyle}>
                              <rect
                                x={x - metrics.gateWidth * 0.52}
                                y={qubitY - metrics.gateHeight * 0.5}
                                width={metrics.gateWidth * 1.04}
                                height={metrics.gateHeight}
                                rx={metrics.detail ? 8 : 4}
                                className="gate-chip measurement"
                              />
                              <text x={x} y={qubitY + 4} textAnchor="middle" className="gate-chip-label">
                                M
                              </text>
                              {clbitY !== null ? (
                                <line
                                  x1={x + metrics.gateWidth * 0.55}
                                  y1={qubitY}
                                  x2={x + metrics.gateWidth * 0.96}
                                  y2={clbitY}
                                  className="measure-line"
                                />
                              ) : null}
                            </g>
                          );
                        })}
                      </g>
                    );
                  }

                  if (gateName === 'swap' && operation.qubits.length === 2) {
                    const top = yForQubit(operation.qubits[0]);
                    const bottom = yForQubit(operation.qubits[1]);
                    const cross = metrics.gateHeight * 0.28;
                    return (
                      <g key={`${layerIndex}-swap-${operationIndex}`} style={chipStyle}>
                        <line x1={x} y1={Math.min(top, bottom)} x2={x} y2={Math.max(top, bottom)} className="gate-link" />
                        <line x1={x - cross} y1={top - cross} x2={x + cross} y2={top + cross} className="swap-mark" />
                        <line x1={x - cross} y1={top + cross} x2={x + cross} y2={top - cross} className="swap-mark" />
                        <line
                          x1={x - cross}
                          y1={bottom - cross}
                          x2={x + cross}
                          y2={bottom + cross}
                          className="swap-mark"
                        />
                        <line
                          x1={x - cross}
                          y1={bottom + cross}
                          x2={x + cross}
                          y2={bottom - cross}
                          className="swap-mark"
                        />
                      </g>
                    );
                  }

                  if (gateName === 'cx' && operation.qubits.length === 2) {
                    const controlY = yForQubit(operation.qubits[0]);
                    const targetY = yForQubit(operation.qubits[1]);
                    const targetRadius = metrics.gateHeight * 0.46;
                    return (
                      <g key={`${layerIndex}-cx-${operationIndex}`} style={chipStyle}>
                        <line x1={x} y1={Math.min(controlY, targetY)} x2={x} y2={Math.max(controlY, targetY)} className="gate-link" />
                        <circle cx={x} cy={controlY} r={metrics.detail ? 5 : 3} className="control-dot" />
                        <circle cx={x} cy={targetY} r={targetRadius} className="target-circle" />
                        <line x1={x - targetRadius * 0.6} y1={targetY} x2={x + targetRadius * 0.6} y2={targetY} className="target-plus" />
                        <line x1={x} y1={targetY - targetRadius * 0.6} x2={x} y2={targetY + targetRadius * 0.6} className="target-plus" />
                      </g>
                    );
                  }

                  if (gateName === 'ccx' && operation.qubits.length === 3) {
                    const [controlA, controlB, target] = operation.qubits;
                    const yValues = [yForQubit(controlA), yForQubit(controlB), yForQubit(target)];
                    const targetY = yValues[2];
                    const targetRadius = metrics.gateHeight * 0.46;
                    return (
                      <g key={`${layerIndex}-ccx-${operationIndex}`} style={chipStyle}>
                        <line x1={x} y1={Math.min(...yValues)} x2={x} y2={Math.max(...yValues)} className="gate-link" />
                        <circle cx={x} cy={yValues[0]} r={metrics.detail ? 4.8 : 3} className="control-dot" />
                        <circle cx={x} cy={yValues[1]} r={metrics.detail ? 4.8 : 3} className="control-dot" />
                        <circle cx={x} cy={targetY} r={targetRadius} className="target-circle" />
                        <line x1={x - targetRadius * 0.6} y1={targetY} x2={x + targetRadius * 0.6} y2={targetY} className="target-plus" />
                        <line x1={x} y1={targetY - targetRadius * 0.6} x2={x} y2={targetY + targetRadius * 0.6} className="target-plus" />
                      </g>
                    );
                  }

                  if (CONTROLLED_GATES.has(gateName) && operation.qubits.length === 2) {
                    const controlY = yForQubit(operation.qubits[0]);
                    const targetY = yForQubit(operation.qubits[1]);
                    const targetLabel = gateName === 'ch' ? 'H' : gateName.startsWith('c') ? gateName.slice(1).toUpperCase() : main;
                    return (
                      <g key={`${layerIndex}-ctrl-${operationIndex}`} style={chipStyle}>
                        <line x1={x} y1={Math.min(controlY, targetY)} x2={x} y2={Math.max(controlY, targetY)} className="gate-link" />
                        <circle cx={x} cy={controlY} r={metrics.detail ? 4.8 : 3.2} className="control-dot" />
                        <rect
                          x={x - metrics.gateWidth * 0.5}
                          y={targetY - metrics.gateHeight * 0.5}
                          width={metrics.gateWidth}
                          height={metrics.gateHeight}
                          rx={metrics.detail ? 8 : 4}
                          className="gate-chip"
                        />
                        <text x={x} y={targetY + 4} textAnchor="middle" className="gate-chip-label">
                          {targetLabel}
                        </text>
                      </g>
                    );
                  }

                  return (
                    <g key={`${layerIndex}-generic-${operationIndex}`} style={chipStyle}>
                      {operation.qubits.length > 1 ? (
                        <line x1={x} y1={minY} x2={x} y2={maxY} className="gate-link" />
                      ) : null}
                      {operation.qubits.map((qubit, qubitIndex) => {
                        const y = yForQubit(qubit);
                        return (
                          <g key={`${layerIndex}-chip-${operationIndex}-${qubit}-${qubitIndex}`}>
                            <rect
                              x={x - metrics.gateWidth * 0.5}
                              y={y - metrics.gateHeight * 0.5}
                              width={metrics.gateWidth}
                              height={metrics.gateHeight}
                              rx={metrics.detail ? 8 : 4}
                              className="gate-chip"
                            />
                            <text x={x} y={y + 2} textAnchor="middle" className="gate-chip-label">
                              {main}
                            </text>
                            {sub && metrics.detail ? (
                              <text x={x} y={y + 12} textAnchor="middle" className="gate-chip-sub">
                                {sub}
                              </text>
                            ) : null}
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
    <section className="panel panel-code">
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
  const [theme, setTheme] = useState<ThemeMode>('light');
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
      document.documentElement.dataset.theme = 'light';
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

      {error ? <section className="panel panel-alert error-panel">{error}</section> : null}
      {loading ? <section className="panel panel-alert loading-panel">Loading research jobs…</section> : null}
      {!loading && filteredJobs.length === 0 ? (
        <section className="panel panel-alert empty-state">
          <h2>No jobs match current filters</h2>
          <p>Run circuits through MCP or adjust filters to populate this console.</p>
        </section>
      ) : null}

      <section className="workspace-layout">
        <section className="panel jobs-panel panel-jobs" aria-label="Jobs list">
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
          <section className="panel panel-meta">
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
            <section className="panel panel-table">
              <div className="panel-header">
                <h3>Job compare diff</h3>
                <p>Primary minus comparison counts</p>
              </div>
              <div className="table-scroll">
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
              </div>
            </section>
          ) : null}

          <ProbabilityTable rows={distribution} />

          <section className="panel panel-chart panel-amplitude">
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
            <section className="panel panel-json">
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

          <section className="panel panel-json">
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
