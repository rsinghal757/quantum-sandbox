'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';

type ThemeMode = 'light' | 'dark';
type RailTab = 'jobs' | 'circuits';
type CodeTab = 'qasm' | 'python' | 'json';
type ResultsMode = 'counts' | 'probabilities';

type DistributionRow = {
  basis_state: string;
  count: number | null;
  probability: number;
  log_count: number;
};

type BlochVector = {
  qubit: number;
  x: number;
  y: number;
  z: number;
  purity: number;
};

type CircuitView = {
  num_qubits: number;
  num_clbits: number;
  depth: number;
  size: number;
  gate_counts: Record<string, number>;
  layers: unknown[];
  structured_gates: Array<Record<string, unknown>>;
  qiskit_python: string;
};

type DerivedPayload = {
  duration_ms?: number | null;
  distribution?: DistributionRow[];
  bloch_vectors?: BlochVector[];
  bloch_unavailable_reason?: string;
  amplitudes?: Array<{ basis_state: string; probability: number; real: number; imag: number }>;
  statevector_source?: string | null;
  replay?: Record<string, unknown>;
  circuit?: CircuitView;
};

type JobSummary = {
  id: string;
  kind: string;
  status: string;
  backend: string | null;
  shots: number | null;
  created_at: string;
  updated_at: string;
  error: string | null;
  circuit_qasm: string;
  derived?: DerivedPayload;
};

type JobDetail = JobSummary & {
  input_payload: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  result_payload: Record<string, unknown> | null;
};

type CircuitRecord = {
  id: string;
  name: string | null;
  qasm: string;
  num_qubits: number;
  num_clbits: number;
  created_at: string;
  updated_at: string;
};

type GateKey =
  | 'h'
  | 'x'
  | 'y'
  | 'z'
  | 's'
  | 't'
  | 'sx'
  | 'rx'
  | 'ry'
  | 'rz'
  | 'p'
  | 'cx'
  | 'cz'
  | 'swap'
  | 'ccx'
  | 'measure'
  | 'barrier';

type PaletteGate = {
  key: GateKey;
  label: string;
  color: string;
  arity: 1 | 2 | 3 | 0;
  paramCount: number;
};

type EditableGate = {
  id: string;
  gate: GateKey;
  qubits: number[];
  clbits: number[];
  params: number[];
};

type EditableCircuit = {
  name: string;
  numQubits: number;
  numClbits: number;
  layers: EditableGate[][];
};

type HistoryState = {
  past: EditableCircuit[];
  present: EditableCircuit;
  future: EditableCircuit[];
};

type HistoryAction =
  | { type: 'apply'; next: EditableCircuit }
  | { type: 'replace'; next: EditableCircuit }
  | { type: 'undo' }
  | { type: 'redo' };

const MAX_HISTORY = 120;
const AUTO_REFRESH_MS = 8000;

const PALETTE: PaletteGate[] = [
  { key: 'h', label: 'H', color: '#4f7df3', arity: 1, paramCount: 0 },
  { key: 'x', label: 'X', color: '#36a2eb', arity: 1, paramCount: 0 },
  { key: 'y', label: 'Y', color: '#3bb273', arity: 1, paramCount: 0 },
  { key: 'z', label: 'Z', color: '#2783bf', arity: 1, paramCount: 0 },
  { key: 's', label: 'S', color: '#9356de', arity: 1, paramCount: 0 },
  { key: 't', label: 'T', color: '#b462e8', arity: 1, paramCount: 0 },
  { key: 'sx', label: 'SX', color: '#2aa6a4', arity: 1, paramCount: 0 },
  { key: 'rx', label: 'RX', color: '#e8775f', arity: 1, paramCount: 1 },
  { key: 'ry', label: 'RY', color: '#e89e47', arity: 1, paramCount: 1 },
  { key: 'rz', label: 'RZ', color: '#eb6f8f', arity: 1, paramCount: 1 },
  { key: 'p', label: 'P', color: '#f0897f', arity: 1, paramCount: 1 },
  { key: 'cx', label: 'CX', color: '#1c9f75', arity: 2, paramCount: 0 },
  { key: 'cz', label: 'CZ', color: '#188d7f', arity: 2, paramCount: 0 },
  { key: 'swap', label: 'SW', color: '#f08f35', arity: 2, paramCount: 0 },
  { key: 'ccx', label: 'CCX', color: '#2eae8f', arity: 3, paramCount: 0 },
  { key: 'measure', label: 'M', color: '#d68d1f', arity: 1, paramCount: 0 },
  { key: 'barrier', label: '||', color: '#68768f', arity: 0, paramCount: 0 },
];

const CONTROLLED_GATES = new Set<GateKey>(['cx', 'cz', 'ccx']);
const PARAMETRIC_GATES = new Set<GateKey>(['rx', 'ry', 'rz', 'p']);

const initialCircuit = (): EditableCircuit => ({
  name: 'Studio draft',
  numQubits: 3,
  numClbits: 3,
  layers: [],
});

const cloneCircuit = (circuit: EditableCircuit): EditableCircuit => ({
  name: circuit.name,
  numQubits: circuit.numQubits,
  numClbits: circuit.numClbits,
  layers: circuit.layers.map((layer) =>
    layer.map((operation) => ({
      ...operation,
      qubits: [...operation.qubits],
      clbits: [...operation.clbits],
      params: [...operation.params],
    })),
  ),
});

const id = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `gate-${Math.random().toString(16).slice(2)}`;
};

const minMax = (values: number[]) => ({ min: Math.min(...values), max: Math.max(...values) });

const normalizeFloat = (value: number) => Number(Number(value).toFixed(8));

const wireKeys = (op: EditableGate) => {
  const keys = new Set<string>();
  op.qubits.forEach((q) => keys.add(`q-${q}`));
  op.clbits.forEach((c) => keys.add(`c-${c}`));
  return keys;
};

const hasCollision = (layer: EditableGate[], candidate: EditableGate, ignoreOpId?: string) => {
  const candidateKeys = wireKeys(candidate);
  return layer.some((existing) => {
    if (ignoreOpId && existing.id === ignoreOpId) {
      return false;
    }
    for (const key of wireKeys(existing)) {
      if (candidateKeys.has(key)) {
        return true;
      }
    }
    return false;
  });
};

const compactLayers = (layers: EditableGate[][]) => {
  const compacted = layers.filter((layer) => layer.length > 0);
  return compacted.length ? compacted : [];
};

const toGatePayload = (circuit: EditableCircuit) =>
  circuit.layers.flatMap((layer) =>
    layer.map((op) => {
      const payload: Record<string, unknown> = {
        gate: op.gate,
        qubits: op.qubits,
      };
      if (op.clbits.length) payload.clbits = op.clbits;
      if (op.params.length) payload.params = op.params;
      return payload;
    }),
  );

const gateByKey = (key: GateKey) => PALETTE.find((gate) => gate.key === key);

const toCircuitFromStructured = (
  structured: Array<Record<string, unknown>>,
  numQubits: number,
  numClbits: number,
  name: string,
): EditableCircuit => {
  let working: EditableCircuit = {
    name,
    numQubits,
    numClbits,
    layers: [],
  };

  const pushOperation = (operation: EditableGate) => {
    const candidate = cloneCircuit(working);
    let targetLayer = 0;
    while (true) {
      if (!candidate.layers[targetLayer]) candidate.layers[targetLayer] = [];
      if (!hasCollision(candidate.layers[targetLayer], operation)) {
        candidate.layers[targetLayer].push(operation);
        break;
      }
      targetLayer += 1;
    }
    working = {
      ...candidate,
      layers: compactLayers(candidate.layers),
    };
  };

  structured.forEach((entry) => {
    const gateName = String(entry.gate ?? '').toLowerCase() as GateKey;
    if (!PALETTE.some((paletteGate) => paletteGate.key === gateName)) {
      return;
    }
    const qubitsRaw = Array.isArray(entry.qubits) ? entry.qubits : Array.isArray(entry.targets) ? entry.targets : [];
    const clbitsRaw = Array.isArray(entry.clbits) ? entry.clbits : [];
    const paramsRaw = Array.isArray(entry.params) ? entry.params : [];

    const operation: EditableGate = {
      id: id(),
      gate: gateName,
      qubits: qubitsRaw.map((value) => Number(value)).filter((value) => Number.isFinite(value)),
      clbits: clbitsRaw.map((value) => Number(value)).filter((value) => Number.isFinite(value)),
      params: paramsRaw
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => normalizeFloat(value)),
    };

    if (!operation.qubits.length && operation.gate !== 'barrier') {
      return;
    }

    pushOperation(operation);
  });

  return working;
};

const historyReducer = (state: HistoryState, action: HistoryAction): HistoryState => {
  if (action.type === 'undo') {
    if (state.past.length === 0) return state;
    const previous = state.past[state.past.length - 1];
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, MAX_HISTORY),
    };
  }

  if (action.type === 'redo') {
    if (state.future.length === 0) return state;
    const [next, ...rest] = state.future;
    return {
      past: [...state.past, state.present].slice(-MAX_HISTORY),
      present: next,
      future: rest,
    };
  }

  if (action.type === 'replace') {
    return {
      past: [],
      present: action.next,
      future: [],
    };
  }

  return {
    past: [...state.past, state.present].slice(-MAX_HISTORY),
    present: action.next,
    future: [],
  };
};

const formatDate = (value: string) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
};

const formatDuration = (durationMs?: number | null) => {
  if (!durationMs || durationMs <= 0) return '—';
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60000) return `${(durationMs / 1000).toFixed(2)} s`;
  return `${(durationMs / 60000).toFixed(2)} min`;
};

const copy = async (text: string) => {
  await navigator.clipboard.writeText(text);
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const histogramRows = (distribution: DistributionRow[] | undefined) => (distribution ?? []).slice(0, 18);

function ResultsHistogram({
  rows,
  mode,
}: {
  rows: DistributionRow[];
  mode: ResultsMode;
}) {
  const width = Math.max(480, rows.length * 42 + 56);
  const height = 230;
  const values = rows.map((row) => (mode === 'counts' ? row.count ?? 0 : row.probability));
  const max = Math.max(...values, 1);

  return (
    <div className="studio-chart-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} className="studio-chart" role="img" aria-label="Result histogram">
        <line x1={20} y1={190} x2={width - 18} y2={190} className="chart-axis" />
        {rows.map((row, index) => {
          const value = mode === 'counts' ? row.count ?? 0 : row.probability;
          const barHeight = (value / max) * 148;
          const x = 28 + index * 40;
          return (
            <g key={row.basis_state}>
              <rect x={x} y={190 - barHeight} width={22} height={barHeight} className="chart-bar" />
              <text x={x + 11} y={208} textAnchor="middle" className="chart-label">
                {row.basis_state}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function BlochView({ vectors, reason }: { vectors: BlochVector[] | undefined; reason: string | undefined }) {
  if (!vectors || vectors.length === 0) {
    return <p className="studio-muted">{reason ?? 'Statevector required to display Bloch vectors.'}</p>;
  }

  return (
    <div className="studio-bloch-grid">
      {vectors.map((vector) => {
        const center = 52;
        const radius = 36;
        const x = clamp(vector.x, -1, 1);
        const z = clamp(vector.z, -1, 1);
        const endX = center + x * radius;
        const endY = center - z * radius;

        return (
          <article className="studio-bloch-card" key={vector.qubit}>
            <strong>q{vector.qubit}</strong>
            <svg viewBox="0 0 104 104" aria-label={`Bloch vector qubit ${vector.qubit}`}>
              <circle cx={center} cy={center} r={radius} className="bloch-sphere" />
              <ellipse cx={center} cy={center} rx={radius} ry={radius * 0.36} className="bloch-ring" />
              <line x1={center - radius} y1={center} x2={center + radius} y2={center} className="bloch-axis" />
              <line x1={center} y1={center - radius} x2={center} y2={center + radius} className="bloch-axis" />
              <line x1={center} y1={center} x2={endX} y2={endY} className="bloch-vector" />
              <circle cx={endX} cy={endY} r={3.3} className="bloch-point" />
            </svg>
            <small>x={x.toFixed(2)} y={vector.y.toFixed(2)} z={z.toFixed(2)}</small>
          </article>
        );
      })}
    </div>
  );
}

const toSketch = (circuit: EditableCircuit) => {
  const lines = ['from qiskit import QuantumCircuit', `qc = QuantumCircuit(${circuit.numQubits}, ${circuit.numClbits})`];
  for (const layer of circuit.layers) {
    for (const op of layer) {
      if (op.gate === 'measure') {
        if (op.qubits.length === 1 && op.clbits.length === 1) {
          lines.push(`qc.measure(${op.qubits[0]}, ${op.clbits[0]})`);
        } else {
          lines.push(`qc.measure(${JSON.stringify(op.qubits)}, ${JSON.stringify(op.clbits)})`);
        }
        continue;
      }

      if (op.gate === 'barrier') {
        lines.push(`qc.barrier(${op.qubits.join(', ')})`);
        continue;
      }

      const params = op.params.map((value) => String(value));
      lines.push(`qc.${op.gate}(${[...params, ...op.qubits.map(String)].join(', ')})`);
    }
  }
  return lines.join('\n');
};

export default function StudioPage() {
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [circuits, setCircuits] = useState<CircuitRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobDetail | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string>('');
  const [selectedOpId, setSelectedOpId] = useState<string>('');
  const [railTab, setRailTab] = useState<RailTab>('jobs');
  const [railSearch, setRailSearch] = useState('');
  const [shots, setShots] = useState(1024);
  const [runBusy, setRunBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [resultsCollapsed, setResultsCollapsed] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeTab, setCodeTab] = useState<CodeTab>('qasm');
  const [resultMode, setResultMode] = useState<ResultsMode>('counts');
  const [activePalette, setActivePalette] = useState<GateKey | null>(null);
  const [lastBuiltQasm, setLastBuiltQasm] = useState('');

  const [historyState, dispatchHistory] = useReducer(historyReducer, {
    past: [],
    present: initialCircuit(),
    future: [],
  });

  const circuit = historyState.present;
  const canUndo = historyState.past.length > 0;
  const canRedo = historyState.future.length > 0;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewport, setViewport] = useState({ width: 900, height: 520, scrollLeft: 0, scrollTop: 0 });

  useEffect(() => {
    const stored = window.localStorage.getItem('quantum-studio-theme');
    if (stored === 'light' || stored === 'dark') {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
    } else {
      document.documentElement.dataset.theme = 'light';
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('quantum-studio-theme', theme);
  }, [theme]);

  const refreshHistory = useCallback(async () => {
    setLoadingHistory(true);
    try {
      const [jobsResp, circuitsResp] = await Promise.all([
        fetch('/api/jobs?limit=120'),
        fetch('/api/circuits?limit=80'),
      ]);
      if (!jobsResp.ok || !circuitsResp.ok) {
        throw new Error('Failed to refresh Studio history from API');
      }
      const jobsPayload = (await jobsResp.json()) as { jobs: JobSummary[] };
      const circuitsPayload = (await circuitsResp.json()) as { circuits: CircuitRecord[] };
      setJobs(jobsPayload.jobs ?? []);
      setCircuits(circuitsPayload.circuits ?? []);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Could not refresh history');
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      void refreshHistory();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refreshHistory]);

  const setCircuit = useCallback((next: EditableCircuit) => {
    dispatchHistory({ type: 'apply', next: cloneCircuit(next) });
  }, []);

  const replaceCircuit = useCallback((next: EditableCircuit) => {
    dispatchHistory({ type: 'replace', next: cloneCircuit(next) });
  }, []);

  const addGateAt = useCallback(
    (gateKey: GateKey, targetLayer: number, targetQubit: number) => {
      const paletteGate = gateByKey(gateKey);
      if (!paletteGate) return;

      const qubit = clamp(targetQubit, 0, Math.max(circuit.numQubits - 1, 0));
      let qubits: number[] = [];
      let clbits: number[] = [];
      let params: number[] = [];

      if (paletteGate.key === 'barrier') {
        qubits = Array.from({ length: circuit.numQubits }, (_, index) => index);
      } else if (paletteGate.key === 'measure') {
        qubits = [qubit];
        clbits = [Math.min(qubit, Math.max(circuit.numClbits - 1, 0))];
      } else if (paletteGate.arity === 1) {
        qubits = [qubit];
      } else if (paletteGate.arity === 2) {
        if (circuit.numQubits < 2) return;
        qubits = [qubit, Math.min(qubit + 1, circuit.numQubits - 1)];
      } else if (paletteGate.arity === 3) {
        if (circuit.numQubits < 3) return;
        const q1 = qubit;
        const q2 = Math.min(qubit + 1, circuit.numQubits - 1);
        const q3 = Math.min(qubit + 2, circuit.numQubits - 1);
        if (new Set([q1, q2, q3]).size < 3) {
          return;
        }
        qubits = [q1, q2, q3];
      }

      params = paletteGate.paramCount ? [Math.PI / 2] : [];

      const candidate: EditableGate = {
        id: id(),
        gate: paletteGate.key,
        qubits,
        clbits,
        params,
      };

      const next = cloneCircuit(circuit);
      let layer = Math.max(0, targetLayer);
      while (true) {
        if (!next.layers[layer]) next.layers[layer] = [];
        if (!hasCollision(next.layers[layer], candidate)) {
          next.layers[layer].push(candidate);
          break;
        }
        layer += 1;
      }

      setCircuit({ ...next, layers: compactLayers(next.layers) });
      setSelectedOpId(candidate.id);
    },
    [circuit, setCircuit],
  );

  const removeSelectedGate = useCallback(() => {
    if (!selectedOpId) return;
    const next = cloneCircuit(circuit);
    next.layers = next.layers.map((layer) => layer.filter((op) => op.id !== selectedOpId));
    next.layers = compactLayers(next.layers);
    setCircuit(next);
    setSelectedOpId('');
  }, [circuit, selectedOpId, setCircuit]);

  const updateSelectedGateParam = useCallback(() => {
    if (!selectedOpId) return;
    const next = cloneCircuit(circuit);
    for (const layer of next.layers) {
      const op = layer.find((candidate) => candidate.id === selectedOpId);
      if (!op || !PARAMETRIC_GATES.has(op.gate)) continue;
      const current = op.params[0] ?? Math.PI / 2;
      const raw = window.prompt('Set gate parameter (radians)', String(current));
      if (raw === null) return;
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) return;
      op.params = [normalizeFloat(parsed)];
      setCircuit(next);
      return;
    }
  }, [circuit, selectedOpId, setCircuit]);

  const moveGate = useCallback(
    (opId: string, targetLayer: number, targetQubit: number) => {
      const next = cloneCircuit(circuit);
      let sourceLayer = -1;
      let sourceOp: EditableGate | null = null;
      for (let layerIndex = 0; layerIndex < next.layers.length; layerIndex += 1) {
        const found = next.layers[layerIndex].find((candidate) => candidate.id === opId);
        if (found) {
          sourceLayer = layerIndex;
          sourceOp = found;
          break;
        }
      }
      if (!sourceOp || sourceLayer < 0) return;

      next.layers[sourceLayer] = next.layers[sourceLayer].filter((op) => op.id !== opId);

      const bounds = minMax(sourceOp.qubits);
      let delta = targetQubit - sourceOp.qubits[0];
      if (bounds.min + delta < 0) delta += Math.abs(bounds.min + delta);
      if (bounds.max + delta >= next.numQubits) delta -= bounds.max + delta - next.numQubits + 1;

      const shifted: EditableGate = {
        ...sourceOp,
        qubits: sourceOp.qubits.map((q) => clamp(q + delta, 0, next.numQubits - 1)),
        clbits: sourceOp.clbits.map((c) => clamp(c + delta, 0, Math.max(next.numClbits - 1, 0))),
      };

      let layerIndex = Math.max(0, targetLayer);
      while (true) {
        if (!next.layers[layerIndex]) next.layers[layerIndex] = [];
        if (!hasCollision(next.layers[layerIndex], shifted, shifted.id)) {
          next.layers[layerIndex].push(shifted);
          break;
        }
        layerIndex += 1;
      }

      next.layers = compactLayers(next.layers);
      setCircuit(next);
      setSelectedOpId(shifted.id);
    },
    [circuit, setCircuit],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedOpId) {
        event.preventDefault();
        removeSelectedGate();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [removeSelectedGate, selectedOpId]);

  const metrics = useMemo(() => {
    const leftPad = 92;
    const topPad = 48;
    const rowGap = 54;
    const colWidth = 72;
    const classicalGap = 50;
    const baseColumns = Math.max(circuit.layers.length + 4, 24);
    const width = leftPad + baseColumns * colWidth + 40;
    const height = topPad + Math.max(circuit.numQubits - 1, 0) * rowGap + classicalGap + Math.max(circuit.numClbits - 1, 0) * rowGap + 70;
    return {
      leftPad,
      topPad,
      rowGap,
      colWidth,
      classicalGap,
      width,
      height,
      chipWidth: 42,
      chipHeight: 32,
    };
  }, [circuit.layers.length, circuit.numQubits, circuit.numClbits]);

  const yForQubit = useCallback((index: number) => metrics.topPad + index * metrics.rowGap, [metrics.rowGap, metrics.topPad]);
  const yForClbit = useCallback(
    (index: number) => metrics.topPad + Math.max(circuit.numQubits - 1, 0) * metrics.rowGap + metrics.classicalGap + index * metrics.rowGap,
    [circuit.numQubits, metrics.classicalGap, metrics.rowGap, metrics.topPad],
  );

  const locateDropTarget = useCallback(
    (clientX: number, clientY: number) => {
      const viewportEl = viewportRef.current;
      if (!viewportEl) return null;
      const bounds = viewportEl.getBoundingClientRect();
      const logicalX = (clientX - bounds.left + viewportEl.scrollLeft) / zoom;
      const logicalY = (clientY - bounds.top + viewportEl.scrollTop) / zoom;
      const layer = Math.max(0, Math.round((logicalX - metrics.leftPad) / metrics.colWidth));
      const qubit = clamp(Math.round((logicalY - metrics.topPad) / metrics.rowGap), 0, Math.max(circuit.numQubits - 1, 0));
      return { layer, qubit };
    },
    [circuit.numQubits, metrics.colWidth, metrics.leftPad, metrics.rowGap, metrics.topPad, zoom],
  );

  const handleCanvasDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = locateDropTarget(event.clientX, event.clientY);
      if (!target) return;

      const newGateKey = event.dataTransfer.getData('application/x-qs-gate');
      if (newGateKey) {
        addGateAt(newGateKey as GateKey, target.layer, target.qubit);
        return;
      }

      const moveOpId = event.dataTransfer.getData('application/x-qs-op');
      if (moveOpId) {
        moveGate(moveOpId, target.layer, target.qubit);
      }
    },
    [addGateAt, locateDropTarget, moveGate],
  );

  const handleCanvasClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!activePalette) return;
      const target = locateDropTarget(event.clientX, event.clientY);
      if (!target) return;
      addGateAt(activePalette, target.layer, target.qubit);
    },
    [activePalette, addGateAt, locateDropTarget],
  );

  useEffect(() => {
    const viewportEl = viewportRef.current;
    if (!viewportEl) return undefined;

    const update = () => {
      setViewport({
        width: viewportEl.clientWidth,
        height: viewportEl.clientHeight,
        scrollLeft: viewportEl.scrollLeft,
        scrollTop: viewportEl.scrollTop,
      });
    };

    update();
    viewportEl.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewportEl.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [metrics.height, metrics.width]);

  const visibleStart = Math.max(0, Math.floor(viewport.scrollLeft / (metrics.colWidth * zoom)) - 2);
  const visibleEnd = Math.min(circuit.layers.length - 1, Math.ceil((viewport.scrollLeft + viewport.width) / (metrics.colWidth * zoom)) + 2);

  const visibleLayers = useMemo(() => {
    if (!circuit.layers.length) return [] as Array<{ layerIndex: number; op: EditableGate }>;
    const result: Array<{ layerIndex: number; op: EditableGate }> = [];
    for (let index = visibleStart; index <= visibleEnd; index += 1) {
      const layer = circuit.layers[index] ?? [];
      layer.forEach((op) => result.push({ layerIndex: index, op }));
    }
    return result;
  }, [circuit.layers, visibleEnd, visibleStart]);

  const filteredJobs = useMemo(() => {
    if (railTab !== 'jobs') return [] as JobSummary[];
    const query = railSearch.trim().toLowerCase();
    if (!query) return jobs;
    return jobs.filter((job) => [job.id, job.kind, job.status, job.backend ?? '', job.error ?? ''].join(' ').toLowerCase().includes(query));
  }, [jobs, railSearch, railTab]);

  const filteredCircuits = useMemo(() => {
    if (railTab !== 'circuits') return [] as CircuitRecord[];
    const query = railSearch.trim().toLowerCase();
    if (!query) return circuits;
    return circuits.filter((record) => [record.id, record.name ?? '', record.qasm].join(' ').toLowerCase().includes(query));
  }, [circuits, railSearch, railTab]);

  const loadJob = useCallback(
    async (jobId: string) => {
      setSelectedJobId(jobId);
      setError(null);
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (!response.ok) {
          throw new Error(`Unable to load job ${jobId}`);
        }
        const payload = (await response.json()) as JobDetail;
        setSelectedJob(payload);
        setLastBuiltQasm(payload.circuit_qasm ?? '');

        const circuitView = payload.derived?.circuit;
        if (circuitView?.structured_gates) {
          const next = toCircuitFromStructured(
            circuitView.structured_gates,
            circuitView.num_qubits,
            circuitView.num_clbits,
            `from job ${jobId.slice(0, 8)}`,
          );
          replaceCircuit(next);
          setSelectedOpId('');
        }
      } catch (jobError) {
        setError(jobError instanceof Error ? jobError.message : 'Could not load job detail');
      }
    },
    [replaceCircuit],
  );

  const loadCircuitRecord = useCallback(
    async (record: CircuitRecord) => {
      setError(null);
      try {
        const response = await fetch('/api/circuit-model', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ circuit_id: record.id }),
        });
        if (!response.ok) {
          throw new Error(`Failed to load circuit ${record.id}`);
        }
        const payload = (await response.json()) as {
          qasm: string;
          circuit: CircuitView;
        };
        const next = toCircuitFromStructured(
          payload.circuit.structured_gates,
          payload.circuit.num_qubits,
          payload.circuit.num_clbits,
          record.name ?? `circuit ${record.id.slice(0, 8)}`,
        );
        replaceCircuit(next);
        setLastBuiltQasm(payload.qasm);
        setSelectedJob(null);
        setSelectedJobId('');
      } catch (circuitError) {
        setError(circuitError instanceof Error ? circuitError.message : 'Could not load circuit');
      }
    },
    [replaceCircuit],
  );

  const runCircuit = useCallback(async () => {
    setRunBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: circuit.name,
          num_qubits: circuit.numQubits,
          num_clbits: circuit.numClbits,
          gates: toGatePayload(circuit),
          shots,
          metadata: {
            source: 'studio',
            mode: 'interactive-editor',
          },
        }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { detail?: string };
        throw new Error(payload.detail ?? `Run failed (${response.status})`);
      }

      const payload = (await response.json()) as { circuit_id: string; job: JobDetail };
      setSelectedJob(payload.job);
      setSelectedJobId(payload.job.id);
      setLastBuiltQasm(payload.job.circuit_qasm ?? '');
      setCodeOpen(true);
      await refreshHistory();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Run failed');
    } finally {
      setRunBusy(false);
    }
  }, [circuit, refreshHistory, shots]);

  const resetCircuitModel = () => {
    replaceCircuit(initialCircuit());
    setSelectedJob(null);
    setSelectedJobId('');
    setSelectedOpId('');
    setLastBuiltQasm('');
  };

  const addQubit = () => {
    if (circuit.numQubits >= 12) return;
    setCircuit({
      ...cloneCircuit(circuit),
      numQubits: circuit.numQubits + 1,
      numClbits: Math.max(circuit.numClbits, circuit.numQubits + 1),
    });
  };

  const removeQubit = () => {
    if (circuit.numQubits <= 1) return;
    const targetQubits = circuit.numQubits - 1;
    const targetClbits = Math.max(1, Math.min(circuit.numClbits, targetQubits));
    const next = cloneCircuit(circuit);
    next.numQubits = targetQubits;
    next.numClbits = targetClbits;
    next.layers = next.layers
      .map((layer) =>
        layer
          .map((op) => ({
            ...op,
            qubits: op.qubits.filter((q) => q < targetQubits),
            clbits: op.clbits.filter((c) => c < targetClbits),
          }))
          .filter((op) => op.gate === 'barrier' || op.qubits.length > 0),
      )
      .filter((layer) => layer.length > 0);
    setCircuit(next);
  };

  const selectedOperation = useMemo(() => {
    if (!selectedOpId) return null;
    for (let layerIndex = 0; layerIndex < circuit.layers.length; layerIndex += 1) {
      const op = circuit.layers[layerIndex].find((candidate) => candidate.id === selectedOpId);
      if (op) return { op, layerIndex };
    }
    return null;
  }, [circuit.layers, selectedOpId]);

  const structuredJson = useMemo(() => JSON.stringify(toGatePayload(circuit), null, 2), [circuit]);
  const qiskitSketch = useMemo(() => toSketch(circuit), [circuit]);
  const qasmText = lastBuiltQasm || '// Run the circuit to generate canonical OpenQASM\n';

  const histogramData = histogramRows(selectedJob?.derived?.distribution);

  return (
    <main className="studio-root">
      <header className="studio-topbar">
        <div>
          <p className="studio-eyebrow">Quantum Sandbox Studio</p>
          <h1>Inspect, edit, and rerun quantum circuits</h1>
          <p className="studio-subtitle">A calm visual workspace for MCP-generated circuits and simulation history.</p>
        </div>
        <div className="studio-top-actions">
          <button type="button" className="studio-button" onClick={() => setTheme((current) => (current === 'light' ? 'dark' : 'light'))}>
            {theme === 'light' ? 'Dark mode' : 'Light mode'}
          </button>
          <button type="button" className="studio-button" onClick={() => void refreshHistory()}>
            Refresh
          </button>
          <label className="studio-toggle">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            Auto refresh
          </label>
        </div>
      </header>

      {error ? <div className="studio-banner studio-banner-error">{error}</div> : null}

      <div className="studio-shell">
        <aside className="studio-rail">
          <div className="studio-rail-header">
            <h2>History</h2>
            <div className="studio-segmented">
              <button
                type="button"
                className={railTab === 'jobs' ? 'active' : ''}
                onClick={() => setRailTab('jobs')}
              >
                Jobs
              </button>
              <button
                type="button"
                className={railTab === 'circuits' ? 'active' : ''}
                onClick={() => setRailTab('circuits')}
              >
                Circuits
              </button>
            </div>
          </div>

          <input
            value={railSearch}
            onChange={(event) => setRailSearch(event.target.value)}
            placeholder={railTab === 'jobs' ? 'Search jobs' : 'Search circuits'}
            aria-label="Search history"
          />

          <div className="studio-rail-list" role="listbox" aria-label="History list">
            {loadingHistory ? <p className="studio-muted">Loading history…</p> : null}

            {railTab === 'jobs'
              ? filteredJobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    role="option"
                    className={`studio-history-item ${selectedJobId === job.id ? 'active' : ''}`}
                    onClick={() => void loadJob(job.id)}
                  >
                    <strong>{job.kind}</strong>
                    <span>{job.id.slice(0, 8)}</span>
                    <small>{job.status} · {formatDate(job.created_at)}</small>
                  </button>
                ))
              : filteredCircuits.map((record) => (
                  <button
                    key={record.id}
                    type="button"
                    role="option"
                    className="studio-history-item"
                    onClick={() => void loadCircuitRecord(record)}
                  >
                    <strong>{record.name ?? 'untitled circuit'}</strong>
                    <span>{record.id.slice(0, 8)}</span>
                    <small>{record.num_qubits}q · {formatDate(record.updated_at)}</small>
                  </button>
                ))}
          </div>
        </aside>

        <section className="studio-center">
          <section className="studio-card studio-palette-card">
            <div className="studio-card-header">
              <h2>Gate palette</h2>
              <p>Drag a gate onto the canvas, or click a gate then click a wire.</p>
            </div>
            <div className="studio-palette-grid">
              {PALETTE.map((gate) => (
                <button
                  key={gate.key}
                  type="button"
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('application/x-qs-gate', gate.key)}
                  className={`studio-palette-chip ${activePalette === gate.key ? 'active' : ''}`}
                  style={{ '--chip': gate.color } as CSSProperties}
                  onClick={() => setActivePalette((current) => (current === gate.key ? null : gate.key))}
                >
                  <strong>{gate.label}</strong>
                  <span>{gate.key.toUpperCase()}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="studio-card studio-canvas-card">
            <div className="studio-card-header studio-toolbar">
              <div>
                <h2>Studio canvas</h2>
                <p>
                  {circuit.numQubits} qubits · {circuit.layers.length} layers · {selectedOperation ? `selected ${selectedOperation.op.gate.toUpperCase()}` : 'no gate selected'}
                </p>
              </div>
              <div className="studio-toolbar-actions">
                <label>
                  Shots
                  <input
                    type="number"
                    min={1}
                    value={shots}
                    onChange={(event) => setShots(Math.max(1, Number(event.target.value) || 1))}
                  />
                </label>
                <button type="button" className="studio-button primary" onClick={() => void runCircuit()} disabled={runBusy}>
                  {runBusy ? 'Running…' : 'Run'}
                </button>
                <button type="button" className="studio-button" onClick={resetCircuitModel}>Reset</button>
                <button type="button" className="studio-button" onClick={() => setSelectedOpId('')}>Reset selection</button>
                <button type="button" className="studio-button" onClick={() => dispatchHistory({ type: 'undo' })} disabled={!canUndo}>Undo</button>
                <button type="button" className="studio-button" onClick={() => dispatchHistory({ type: 'redo' })} disabled={!canRedo}>Redo</button>
                <button type="button" className="studio-button" onClick={addQubit}>+ qubit</button>
                <button type="button" className="studio-button" onClick={removeQubit}>- qubit</button>
                <button type="button" className="studio-button" onClick={() => setZoom((z) => clamp(z / 1.2, 0.45, 2.4))}>-</button>
                <button type="button" className="studio-button" onClick={() => setZoom((z) => clamp(z * 1.2, 0.45, 2.4))}>+</button>
                <button type="button" className="studio-button" onClick={() => setZoom(1)}>Reset zoom</button>
                <button type="button" className="studio-button" onClick={updateSelectedGateParam} disabled={!selectedOperation || !PARAMETRIC_GATES.has(selectedOperation.op.gate)}>
                  Edit param
                </button>
                <button type="button" className="studio-button" onClick={removeSelectedGate} disabled={!selectedOperation}>Delete</button>
              </div>
            </div>

            <div className="studio-canvas-meta">
              <span>Active placement: {activePalette ? activePalette.toUpperCase() : 'none'}</span>
              <span>Visible layers {Math.max(visibleStart + 1, 1)}-{Math.max(visibleEnd + 1, 1)}</span>
            </div>

            <div
              ref={viewportRef}
              className="studio-canvas-viewport"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleCanvasDrop}
              onClick={handleCanvasClick}
            >
              <div
                className="studio-canvas-shell"
                style={{
                  width: `${Math.ceil(metrics.width * zoom)}px`,
                  height: `${Math.ceil(metrics.height * zoom)}px`,
                }}
              >
                <div
                  className="studio-canvas-content"
                  style={{
                    width: `${metrics.width}px`,
                    height: `${metrics.height}px`,
                    transform: `scale(${zoom})`,
                  }}
                >
                  {Array.from({ length: circuit.numQubits }).map((_, qubit) => (
                    <div
                      key={`wire-q-${qubit}`}
                      className="studio-wire"
                      style={{
                        left: `${metrics.leftPad - 12}px`,
                        right: '18px',
                        top: `${yForQubit(qubit)}px`,
                      }}
                    >
                      <span className="studio-wire-label">q{qubit}</span>
                    </div>
                  ))}

                  {Array.from({ length: circuit.numClbits }).map((_, clbit) => (
                    <div
                      key={`wire-c-${clbit}`}
                      className="studio-wire classical"
                      style={{
                        left: `${metrics.leftPad - 12}px`,
                        right: '18px',
                        top: `${yForClbit(clbit)}px`,
                      }}
                    >
                      <span className="studio-wire-label">c{clbit}</span>
                    </div>
                  ))}

                  {visibleLayers.map(({ layerIndex, op }) => {
                    const x = metrics.leftPad + layerIndex * metrics.colWidth;
                    const chipColor = gateByKey(op.gate)?.color ?? '#77839a';
                    const style = { '--chip': chipColor } as CSSProperties;

                    const qubitYs = op.qubits.map(yForQubit);
                    const clbitYs = op.clbits.map(yForClbit);
                    const connectorMin = Math.min(...qubitYs, ...(clbitYs.length ? clbitYs : [qubitYs[0] ?? 0]));
                    const connectorMax = Math.max(...qubitYs, ...(clbitYs.length ? clbitYs : [qubitYs[0] ?? 0]));

                    const dragAttrs = {
                      draggable: true,
                      onDragStart: (event: DragEvent<HTMLButtonElement>) => {
                        event.dataTransfer.setData('application/x-qs-op', op.id);
                      },
                    };

                    if (op.gate === 'barrier') {
                      return (
                        <div
                          key={op.id}
                          className="studio-barrier"
                          style={{ left: `${x + metrics.chipWidth / 2}px`, top: `${connectorMin - 20}px`, height: `${connectorMax - connectorMin + 40}px` }}
                        />
                      );
                    }

                    return (
                      <div key={op.id} className="studio-op-layer" style={style}>
                        {op.qubits.length > 1 ? (
                          <div
                            className="studio-op-connector"
                            style={{ left: `${x + metrics.chipWidth / 2}px`, top: `${connectorMin}px`, height: `${connectorMax - connectorMin}px` }}
                          />
                        ) : null}

                        {op.gate === 'cx' && op.qubits.length === 2 ? (
                          <>
                            <div className="studio-control-dot" style={{ left: `${x + 18}px`, top: `${qubitYs[0] - 5}px` }} />
                            <div className="studio-target" style={{ left: `${x + 9}px`, top: `${qubitYs[1] - 10}px` }} />
                          </>
                        ) : null}

                        {op.gate === 'cz' && op.qubits.length === 2 ? (
                          <>
                            <div className="studio-control-dot" style={{ left: `${x + 18}px`, top: `${qubitYs[0] - 5}px` }} />
                            <button
                              type="button"
                              {...dragAttrs}
                              className={`studio-gate-chip ${selectedOpId === op.id ? 'selected' : ''}`}
                              style={{ left: `${x}px`, top: `${qubitYs[1] - metrics.chipHeight / 2}px` }}
                              onClick={() => setSelectedOpId(op.id)}
                            >
                              Z
                            </button>
                          </>
                        ) : null}

                        {op.gate === 'ccx' && op.qubits.length === 3 ? (
                          <>
                            <div className="studio-control-dot" style={{ left: `${x + 18}px`, top: `${qubitYs[0] - 5}px` }} />
                            <div className="studio-control-dot" style={{ left: `${x + 18}px`, top: `${qubitYs[1] - 5}px` }} />
                            <div className="studio-target" style={{ left: `${x + 9}px`, top: `${qubitYs[2] - 10}px` }} />
                          </>
                        ) : null}

                        {op.gate === 'swap' && op.qubits.length === 2 ? (
                          <>
                            <div className="studio-swap-mark" style={{ left: `${x + 16}px`, top: `${qubitYs[0] - 8}px` }}>×</div>
                            <div className="studio-swap-mark" style={{ left: `${x + 16}px`, top: `${qubitYs[1] - 8}px` }}>×</div>
                          </>
                        ) : null}

                        {op.gate === 'measure' ? (
                          op.qubits.map((qubit, index) => {
                            const chipY = yForQubit(qubit);
                            const clbit = op.clbits[index];
                            const clbitY = clbit === undefined ? null : yForClbit(clbit);
                            return (
                              <div key={`${op.id}-m-${qubit}`}>
                                <button
                                  type="button"
                                  {...dragAttrs}
                                  className={`studio-gate-chip measure ${selectedOpId === op.id ? 'selected' : ''}`}
                                  style={{ left: `${x}px`, top: `${chipY - metrics.chipHeight / 2}px` }}
                                  onClick={() => setSelectedOpId(op.id)}
                                >
                                  M
                                </button>
                                {clbitY !== null ? (
                                  <div
                                    className="studio-measure-link"
                                    style={{
                                      left: `${x + metrics.chipWidth}px`,
                                      top: `${Math.min(chipY, clbitY)}px`,
                                      height: `${Math.abs(clbitY - chipY)}px`,
                                    }}
                                  />
                                ) : null}
                              </div>
                            );
                          })
                        ) : null}

                        {!['cx', 'cz', 'ccx', 'swap', 'measure', 'barrier'].includes(op.gate)
                          ? op.qubits.map((qubit) => {
                              const chipY = yForQubit(qubit);
                              const label = op.gate.toUpperCase();
                              const param = op.params[0];
                              return (
                                <button
                                  key={`${op.id}-${qubit}`}
                                  type="button"
                                  {...dragAttrs}
                                  className={`studio-gate-chip ${selectedOpId === op.id ? 'selected' : ''}`}
                                  style={{ left: `${x}px`, top: `${chipY - metrics.chipHeight / 2}px` }}
                                  onClick={() => setSelectedOpId(op.id)}
                                >
                                  <span>{label}</span>
                                  {param !== undefined ? <small>{param.toFixed(2)}</small> : null}
                                </button>
                              );
                            })
                          : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <section className={`studio-card studio-code-drawer ${codeOpen ? 'open' : 'closed'}`}>
            <div className="studio-card-header">
              <h2>Code drawer</h2>
              <div className="studio-toolbar-actions">
                <button type="button" className="studio-button" onClick={() => setCodeOpen((open) => !open)}>
                  {codeOpen ? 'Hide' : 'Show'}
                </button>
                <button type="button" className="studio-button" onClick={() => copy(codeTab === 'qasm' ? qasmText : codeTab === 'python' ? qiskitSketch : structuredJson)}>
                  Copy
                </button>
              </div>
            </div>
            {codeOpen ? (
              <>
                <div className="studio-segmented">
                  <button type="button" className={codeTab === 'qasm' ? 'active' : ''} onClick={() => setCodeTab('qasm')}>OpenQASM</button>
                  <button type="button" className={codeTab === 'python' ? 'active' : ''} onClick={() => setCodeTab('python')}>Qiskit sketch</button>
                  <button type="button" className={codeTab === 'json' ? 'active' : ''} onClick={() => setCodeTab('json')}>Gate JSON</button>
                </div>
                <pre className="studio-code-view">{codeTab === 'qasm' ? qasmText : codeTab === 'python' ? qiskitSketch : structuredJson}</pre>
              </>
            ) : null}
          </section>
        </section>

        <aside className={`studio-results ${resultsCollapsed ? 'collapsed' : ''}`}>
          <div className="studio-results-header">
            <h2>Results</h2>
            <button type="button" className="studio-button" onClick={() => setResultsCollapsed((value) => !value)}>
              {resultsCollapsed ? 'Open' : 'Collapse'}
            </button>
          </div>

          {!resultsCollapsed ? (
            <div className="studio-results-body">
              {selectedJob ? (
                <>
                  <section className="studio-results-card">
                    <h3>{selectedJob.kind}</h3>
                    <p>{selectedJob.id}</p>
                    <p>
                      {selectedJob.status} · {selectedJob.backend ?? 'n/a'} · {selectedJob.shots ?? 'n/a'} shots
                    </p>
                    <p>Duration: {formatDuration(selectedJob.derived?.duration_ms)}</p>
                  </section>

                  <section className="studio-results-card">
                    <div className="studio-card-header inline-controls">
                      <h3>Histogram</h3>
                      <select value={resultMode} onChange={(event) => setResultMode(event.target.value as ResultsMode)}>
                        <option value="counts">Counts</option>
                        <option value="probabilities">Probabilities</option>
                      </select>
                    </div>
                    <ResultsHistogram rows={histogramData} mode={resultMode} />
                  </section>

                  <section className="studio-results-card">
                    <h3>Probabilities</h3>
                    <div className="studio-table-scroll">
                      <table className="studio-table">
                        <thead>
                          <tr>
                            <th>State</th>
                            <th>Count</th>
                            <th>Prob</th>
                          </tr>
                        </thead>
                        <tbody>
                          {histogramData.map((row) => (
                            <tr key={row.basis_state}>
                              <td>{row.basis_state}</td>
                              <td>{row.count ?? '—'}</td>
                              <td>{(row.probability * 100).toFixed(2)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>

                  <section className="studio-results-card">
                    <h3>Bloch</h3>
                    <BlochView vectors={selectedJob.derived?.bloch_vectors} reason={selectedJob.derived?.bloch_unavailable_reason} />
                  </section>
                </>
              ) : (
                <div className="studio-empty">
                  <p>Select a history item or run the current circuit to see results.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="studio-results-collapsed-hint">Results hidden</div>
          )}
        </aside>
      </div>
    </main>
  );
}
