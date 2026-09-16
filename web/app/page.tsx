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
  arity: 0 | 1 | 2 | 3;
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
const AUTO_REFRESH_MS = 7000;

const PALETTE: PaletteGate[] = [
  { key: 'h', label: 'H', color: '#4f7df3', arity: 1, paramCount: 0 },
  { key: 'x', label: 'X', color: '#36a2eb', arity: 1, paramCount: 0 },
  { key: 'y', label: 'Y', color: '#3ab27a', arity: 1, paramCount: 0 },
  { key: 'z', label: 'Z', color: '#2b86c7', arity: 1, paramCount: 0 },
  { key: 's', label: 'S', color: '#9558df', arity: 1, paramCount: 0 },
  { key: 't', label: 'T', color: '#b466e8', arity: 1, paramCount: 0 },
  { key: 'sx', label: 'SX', color: '#2da8a6', arity: 1, paramCount: 0 },
  { key: 'rx', label: 'RX', color: '#e97a62', arity: 1, paramCount: 1 },
  { key: 'ry', label: 'RY', color: '#e89d45', arity: 1, paramCount: 1 },
  { key: 'rz', label: 'RZ', color: '#ea6f90', arity: 1, paramCount: 1 },
  { key: 'p', label: 'P', color: '#f08b7d', arity: 1, paramCount: 1 },
  { key: 'cx', label: 'CX', color: '#1f9a72', arity: 2, paramCount: 0 },
  { key: 'cz', label: 'CZ', color: '#1f8f7d', arity: 2, paramCount: 0 },
  { key: 'swap', label: 'SW', color: '#ee8f35', arity: 2, paramCount: 0 },
  { key: 'ccx', label: 'CCX', color: '#2dae8f', arity: 3, paramCount: 0 },
  { key: 'measure', label: 'M', color: '#d4922a', arity: 1, paramCount: 0 },
  { key: 'barrier', label: '||', color: '#76839a', arity: 0, paramCount: 0 },
];

const PARAMETRIC_GATES = new Set<GateKey>(['rx', 'ry', 'rz', 'p']);

const createGateId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `gate-${Math.random().toString(16).slice(2)}`;
};

const cloneCircuit = (circuit: EditableCircuit): EditableCircuit => ({
  name: circuit.name,
  numQubits: circuit.numQubits,
  numClbits: circuit.numClbits,
  layers: circuit.layers.map((layer) =>
    layer.map((op) => ({
      ...op,
      qubits: [...op.qubits],
      clbits: [...op.clbits],
      params: [...op.params],
    })),
  ),
});

const initialCircuit = (): EditableCircuit => ({
  name: 'Studio Draft',
  numQubits: 3,
  numClbits: 3,
  layers: [],
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const gateLookup = (key: GateKey) => PALETTE.find((item) => item.key === key);

const wireSet = (op: EditableGate) => {
  const wireIds = new Set<string>();
  op.qubits.forEach((q) => wireIds.add(`q-${q}`));
  op.clbits.forEach((c) => wireIds.add(`c-${c}`));
  return wireIds;
};

const layerCollides = (layer: EditableGate[], candidate: EditableGate, ignoreId?: string) => {
  const candidateWires = wireSet(candidate);
  return layer.some((op) => {
    if (ignoreId && op.id === ignoreId) return false;
    for (const wire of wireSet(op)) {
      if (candidateWires.has(wire)) return true;
    }
    return false;
  });
};

const compactLayers = (layers: EditableGate[][]) => layers.filter((layer) => layer.length > 0);

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

const toCircuitFromStructured = (
  structured: Array<Record<string, unknown>>,
  numQubits: number,
  numClbits: number,
  name: string,
): EditableCircuit => {
  let circuit: EditableCircuit = {
    name,
    numQubits,
    numClbits,
    layers: [],
  };

  for (const item of structured) {
    const gate = String(item.gate ?? '').toLowerCase() as GateKey;
    if (!PALETTE.some((p) => p.key === gate)) continue;

    const qubits = (Array.isArray(item.qubits) ? item.qubits : Array.isArray(item.targets) ? item.targets : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));

    const clbits = (Array.isArray(item.clbits) ? item.clbits : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v));

    const params = (Array.isArray(item.params) ? item.params : [])
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v))
      .map((v) => Number(v.toFixed(8)));

    if (gate !== 'barrier' && qubits.length === 0) continue;

    const op: EditableGate = { id: createGateId(), gate, qubits, clbits, params };
    const next = cloneCircuit(circuit);
    let layerIndex = 0;
    while (true) {
      if (!next.layers[layerIndex]) next.layers[layerIndex] = [];
      if (!layerCollides(next.layers[layerIndex], op)) {
        next.layers[layerIndex].push(op);
        break;
      }
      layerIndex += 1;
    }
    circuit = { ...next, layers: compactLayers(next.layers) };
  }

  return circuit;
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

const copyText = async (text: string) => {
  await navigator.clipboard.writeText(text);
};

const circuitToOpenQasm = (circuit: EditableCircuit) => {
  const lines: string[] = [
    'OPENQASM 2.0;',
    'include "qelib1.inc";',
    `qreg q[${circuit.numQubits}];`,
    `creg c[${circuit.numClbits}];`,
  ];

  for (const layer of circuit.layers) {
    for (const op of layer) {
      const qRefs = op.qubits.map((q) => `q[${q}]`);
      if (op.gate === 'barrier') {
        lines.push(`barrier ${qRefs.join(',')};`);
        continue;
      }
      if (op.gate === 'measure') {
        op.qubits.forEach((q, index) => {
          const c = op.clbits[index] ?? q;
          lines.push(`measure q[${q}] -> c[${c}];`);
        });
        continue;
      }

      if (op.gate === 'ccx' && op.qubits.length === 3) {
        lines.push(`ccx ${qRefs.join(',')};`);
        continue;
      }

      if ((op.gate === 'cx' || op.gate === 'cz' || op.gate === 'swap') && op.qubits.length === 2) {
        lines.push(`${op.gate} ${qRefs.join(',')};`);
        continue;
      }

      const paramSection = op.params.length ? `(${op.params.map((value) => Number(value.toFixed(8))).join(',')})` : '';
      lines.push(`${op.gate}${paramSection} ${qRefs.join(',')};`);
    }
  }

  return `${lines.join('\n')}\n`;
};

const circuitToQiskitSketch = (circuit: EditableCircuit) => {
  const lines = ['from qiskit import QuantumCircuit', `qc = QuantumCircuit(${circuit.numQubits}, ${circuit.numClbits})`];

  for (const layer of circuit.layers) {
    for (const op of layer) {
      if (op.gate === 'measure') {
        op.qubits.forEach((qubit, index) => {
          const clbit = op.clbits[index] ?? qubit;
          lines.push(`qc.measure(${qubit}, ${clbit})`);
        });
        continue;
      }

      if (op.gate === 'barrier') {
        lines.push(`qc.barrier(${op.qubits.join(', ')})`);
        continue;
      }

      const args = [...op.params.map((value) => Number(value.toFixed(8))), ...op.qubits].join(', ');
      lines.push(`qc.${op.gate}(${args})`);
    }
  }

  return lines.join('\n');
};

function ResultsHistogram({ rows, mode }: { rows: DistributionRow[]; mode: ResultsMode }) {
  const width = Math.max(520, Math.max(rows.length, 2) * 42 + 60);
  const height = 240;
  const values = rows.map((row) => (mode === 'counts' ? row.count ?? 0 : row.probability));
  const max = Math.max(...values, 1);

  return (
    <div className="studio-chart-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} className="studio-chart" role="img" aria-label="Histogram">
        <line x1={20} y1={196} x2={width - 18} y2={196} className="chart-axis" />
        {rows.length === 0 ? (
          <text x={width / 2} y={118} textAnchor="middle" className="chart-empty">
            Run a circuit to populate histogram bins.
          </text>
        ) : null}
        {rows.map((row, index) => {
          const value = mode === 'counts' ? row.count ?? 0 : row.probability;
          const barHeight = (value / max) * 150;
          const x = 30 + index * 40;
          return (
            <g key={row.basis_state}>
              <rect x={x} y={196 - barHeight} width={22} height={barHeight} className="chart-bar" />
              <text x={x + 11} y={214} textAnchor="middle" className="chart-label">
                {row.basis_state}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function BlochPanel({ vectors, reason }: { vectors: BlochVector[] | undefined; reason: string | undefined }) {
  if (!vectors || vectors.length === 0) {
    return <p className="studio-muted">{reason ?? 'Statevector is required to render Bloch vectors.'}</p>;
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
            <strong>q[{vector.qubit}]</strong>
            <svg viewBox="0 0 104 104" aria-label={`Bloch q${vector.qubit}`}>
              <circle cx={center} cy={center} r={radius} className="bloch-sphere" />
              <ellipse cx={center} cy={center} rx={radius} ry={radius * 0.36} className="bloch-ring" />
              <line x1={center - radius} y1={center} x2={center + radius} y2={center} className="bloch-axis" />
              <line x1={center} y1={center - radius} x2={center} y2={center + radius} className="bloch-axis" />
              <line x1={center} y1={center} x2={endX} y2={endY} className="bloch-vector" />
              <circle cx={endX} cy={endY} r={3.3} className="bloch-point" />
            </svg>
            <small>
              x={x.toFixed(2)} y={vector.y.toFixed(2)} z={z.toFixed(2)}
            </small>
          </article>
        );
      })}
    </div>
  );
}

export default function StudioPage() {
  const [theme, setTheme] = useState<ThemeMode>('light');
  const [railTab, setRailTab] = useState<RailTab>('jobs');
  const [railSearch, setRailSearch] = useState('');
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [circuits, setCircuits] = useState<CircuitRecord[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobDetail | null>(null);
  const [selectedJobId, setSelectedJobId] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [shots, setShots] = useState(1024);
  const [runBusy, setRunBusy] = useState(false);
  const [activePalette, setActivePalette] = useState<GateKey | null>(null);
  const [selectedOpId, setSelectedOpId] = useState('');
  const [zoom, setZoom] = useState(1);

  const [codeTab, setCodeTab] = useState<CodeTab>('qasm');
  const [qasmDraft, setQasmDraft] = useState('');
  const [qasmDirty, setQasmDirty] = useState(false);
  const [qasmApplying, setQasmApplying] = useState(false);
  const [resultsMode, setResultsMode] = useState<ResultsMode>('counts');

  const [historyState, dispatchHistory] = useReducer(historyReducer, {
    past: [],
    present: initialCircuit(),
    future: [],
  });

  const circuit = historyState.present;
  const canUndo = historyState.past.length > 0;
  const canRedo = historyState.future.length > 0;

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 920, scrollLeft: 0 });

  const setCircuit = useCallback((next: EditableCircuit) => {
    dispatchHistory({ type: 'apply', next: cloneCircuit(next) });
  }, []);

  const replaceCircuit = useCallback((next: EditableCircuit) => {
    dispatchHistory({ type: 'replace', next: cloneCircuit(next) });
  }, []);

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
      const [jobsResp, circuitsResp] = await Promise.all([fetch('/api/jobs?limit=120'), fetch('/api/circuits?limit=90')]);
      if (!jobsResp.ok || !circuitsResp.ok) {
        throw new Error('Failed to load history from API');
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

  const selectedOperation = useMemo(() => {
    if (!selectedOpId) return null;
    for (let layerIndex = 0; layerIndex < circuit.layers.length; layerIndex += 1) {
      const op = circuit.layers[layerIndex].find((candidate) => candidate.id === selectedOpId);
      if (op) return { op, layerIndex };
    }
    return null;
  }, [circuit.layers, selectedOpId]);

  const measuredQubits = useMemo(() => {
    const bits = new Set<number>();
    circuit.layers.forEach((layer) => {
      layer.forEach((op) => {
        if (op.gate === 'measure') op.qubits.forEach((q) => bits.add(q));
      });
    });
    return bits;
  }, [circuit.layers]);

  const metrics = useMemo(() => {
    const leftPad = 108;
    const topPad = 44;
    const rowGap = 48;
    const colWidth = 64;
    const classicalGap = 48;
    const chipWidth = 36;
    const chipHeight = 28;
    const baseColumns = Math.max(circuit.layers.length + 5, 26);
    const width = leftPad + baseColumns * colWidth + 56;
    const height = topPad + Math.max(circuit.numQubits - 1, 0) * rowGap + classicalGap + Math.max(circuit.numClbits - 1, 0) * rowGap + 72;
    return { leftPad, topPad, rowGap, colWidth, classicalGap, chipWidth, chipHeight, width, height };
  }, [circuit.layers.length, circuit.numQubits, circuit.numClbits]);

  const yForQubit = useCallback((index: number) => metrics.topPad + index * metrics.rowGap, [metrics.rowGap, metrics.topPad]);
  const yForClbit = useCallback(
    (index: number) => metrics.topPad + Math.max(circuit.numQubits - 1, 0) * metrics.rowGap + metrics.classicalGap + index * metrics.rowGap,
    [circuit.numQubits, metrics.classicalGap, metrics.rowGap, metrics.topPad],
  );

  useEffect(() => {
    const viewportEl = viewportRef.current;
    if (!viewportEl) return undefined;

    const update = () => {
      setViewport({ width: viewportEl.clientWidth, scrollLeft: viewportEl.scrollLeft });
    };

    update();
    viewportEl.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewportEl.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [metrics.height, metrics.width]);

  const addGateAt = useCallback(
    (gateKey: GateKey, targetLayer: number, targetQubit: number) => {
      const gate = gateLookup(gateKey);
      if (!gate) return;

      const qubit = clamp(targetQubit, 0, Math.max(circuit.numQubits - 1, 0));
      let qubits: number[] = [];
      let clbits: number[] = [];

      if (gate.key === 'barrier') {
        qubits = Array.from({ length: circuit.numQubits }, (_, idx) => idx);
      } else if (gate.key === 'measure') {
        qubits = [qubit];
        clbits = [Math.min(qubit, Math.max(circuit.numClbits - 1, 0))];
      } else if (gate.arity === 1) {
        qubits = [qubit];
      } else if (gate.arity === 2) {
        if (circuit.numQubits < 2) return;
        qubits = [qubit, Math.min(qubit + 1, circuit.numQubits - 1)];
      } else if (gate.arity === 3) {
        if (circuit.numQubits < 3) return;
        const q2 = Math.min(qubit + 1, circuit.numQubits - 1);
        const q3 = Math.min(qubit + 2, circuit.numQubits - 1);
        if (new Set([qubit, q2, q3]).size < 3) return;
        qubits = [qubit, q2, q3];
      }

      const operation: EditableGate = {
        id: createGateId(),
        gate: gate.key,
        qubits,
        clbits,
        params: gate.paramCount ? [Math.PI / 2] : [],
      };

      const next = cloneCircuit(circuit);
      let layerIndex = Math.max(0, targetLayer);
      while (true) {
        if (!next.layers[layerIndex]) next.layers[layerIndex] = [];
        if (!layerCollides(next.layers[layerIndex], operation)) {
          next.layers[layerIndex].push(operation);
          break;
        }
        layerIndex += 1;
      }

      setCircuit({ ...next, layers: compactLayers(next.layers) });
      setSelectedOpId(operation.id);
    },
    [circuit, setCircuit],
  );

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

      let delta = targetQubit - sourceOp.qubits[0];
      const minQ = Math.min(...sourceOp.qubits);
      const maxQ = Math.max(...sourceOp.qubits);
      if (minQ + delta < 0) delta += Math.abs(minQ + delta);
      if (maxQ + delta >= next.numQubits) delta -= maxQ + delta - next.numQubits + 1;

      const shifted: EditableGate = {
        ...sourceOp,
        qubits: sourceOp.qubits.map((q) => clamp(q + delta, 0, next.numQubits - 1)),
        clbits: sourceOp.clbits.map((c) => clamp(c + delta, 0, Math.max(next.numClbits - 1, 0))),
      };

      let layerIndex = Math.max(0, targetLayer);
      while (true) {
        if (!next.layers[layerIndex]) next.layers[layerIndex] = [];
        if (!layerCollides(next.layers[layerIndex], shifted, shifted.id)) {
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

  const removeSelectedGate = useCallback(() => {
    if (!selectedOpId) return;
    const next = cloneCircuit(circuit);
    next.layers = compactLayers(next.layers.map((layer) => layer.filter((op) => op.id !== selectedOpId)));
    setCircuit(next);
    setSelectedOpId('');
  }, [circuit, selectedOpId, setCircuit]);

  const editSelectedParameter = useCallback(() => {
    if (!selectedOperation || !PARAMETRIC_GATES.has(selectedOperation.op.gate)) return;
    const next = cloneCircuit(circuit);
    const op = next.layers[selectedOperation.layerIndex].find((candidate) => candidate.id === selectedOperation.op.id);
    if (!op) return;
    const current = op.params[0] ?? Math.PI / 2;
    const raw = window.prompt('Set gate parameter (radians)', String(current));
    if (raw === null) return;
    const parsed = Number(raw);
    if (Number.isNaN(parsed)) return;
    op.params = [Number(parsed.toFixed(8))];
    setCircuit(next);
  }, [circuit, selectedOperation, setCircuit]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedOpId) {
        event.preventDefault();
        removeSelectedGate();
      }
    };

    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [removeSelectedGate, selectedOpId]);

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

      const gateKey = event.dataTransfer.getData('application/x-qs-gate');
      if (gateKey) {
        addGateAt(gateKey as GateKey, target.layer, target.qubit);
        return;
      }

      const movedOp = event.dataTransfer.getData('application/x-qs-op');
      if (movedOp) {
        moveGate(movedOp, target.layer, target.qubit);
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

  const loadJob = useCallback(
    async (jobId: string) => {
      setSelectedJobId(jobId);
      setError(null);
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (!response.ok) throw new Error(`Unable to load job ${jobId}`);
        const payload = (await response.json()) as JobDetail;
        setSelectedJob(payload);

        const circuitView = payload.derived?.circuit;
        if (circuitView?.structured_gates) {
          const next = toCircuitFromStructured(
            circuitView.structured_gates,
            circuitView.num_qubits,
            circuitView.num_clbits,
            payload.kind,
          );
          replaceCircuit(next);
          setQasmDirty(false);
          setSelectedOpId('');
        }
      } catch (jobError) {
        setError(jobError instanceof Error ? jobError.message : 'Could not load job detail');
      }
    },
    [replaceCircuit],
  );

  const loadCircuit = useCallback(
    async (record: CircuitRecord) => {
      setError(null);
      try {
        const response = await fetch('/api/circuit-model', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ circuit_id: record.id }),
        });
        if (!response.ok) throw new Error(`Unable to load circuit ${record.id}`);
        const payload = (await response.json()) as { circuit: CircuitView };
        const next = toCircuitFromStructured(
          payload.circuit.structured_gates,
          payload.circuit.num_qubits,
          payload.circuit.num_clbits,
          record.name ?? 'Loaded circuit',
        );
        replaceCircuit(next);
        setQasmDirty(false);
        setSelectedOpId('');
        setSelectedJob(null);
        setSelectedJobId('');
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Could not load circuit');
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
            mode: 'composer-like-loop',
          },
        }),
      });

      if (!response.ok) {
        const errPayload = (await response.json()) as { detail?: string };
        throw new Error(errPayload.detail ?? `Run failed (${response.status})`);
      }

      const payload = (await response.json()) as { circuit_id: string; job: JobDetail };
      setSelectedJob(payload.job);
      setSelectedJobId(payload.job.id);
      setQasmDirty(false);
      setRailTab('jobs');
      await refreshHistory();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Run failed');
    } finally {
      setRunBusy(false);
    }
  }, [circuit, refreshHistory, shots]);

  const applyQasmToCanvas = useCallback(async () => {
    if (!qasmDraft.trim()) return;
    setQasmApplying(true);
    setError(null);
    try {
      const response = await fetch('/api/circuit-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ qasm: qasmDraft }),
      });
      if (!response.ok) {
        const errPayload = (await response.json()) as { detail?: string };
        throw new Error(errPayload.detail ?? `Unable to parse OpenQASM (${response.status})`);
      }
      const payload = (await response.json()) as { qasm: string; circuit: CircuitView };
      const next = toCircuitFromStructured(
        payload.circuit.structured_gates,
        payload.circuit.num_qubits,
        payload.circuit.num_clbits,
        circuit.name,
      );
      replaceCircuit(next);
      setQasmDraft(payload.qasm ?? qasmDraft);
      setQasmDirty(false);
      setSelectedOpId('');
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Failed to apply OpenQASM');
    } finally {
      setQasmApplying(false);
    }
  }, [circuit.name, qasmDraft, replaceCircuit]);

  const resetCircuit = () => {
    replaceCircuit(initialCircuit());
    setQasmDirty(false);
    setSelectedOpId('');
    setSelectedJob(null);
    setSelectedJobId('');
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
    next.layers = compactLayers(
      next.layers
        .map((layer) =>
          layer
            .map((op) => ({
              ...op,
              qubits: op.qubits.filter((q) => q < targetQubits),
              clbits: op.clbits.filter((c) => c < targetClbits),
            }))
            .filter((op) => op.gate === 'barrier' || op.qubits.length > 0),
        )
        .filter((layer) => layer.length > 0),
    );
    setCircuit(next);
  };

  const filteredJobs = useMemo(() => {
    if (railTab !== 'jobs') return [] as JobSummary[];
    const query = railSearch.trim().toLowerCase();
    if (!query) return jobs;
    return jobs.filter((job) =>
      [job.id, job.kind, job.status, job.backend ?? '', job.error ?? ''].join(' ').toLowerCase().includes(query),
    );
  }, [jobs, railSearch, railTab]);

  const filteredCircuits = useMemo(() => {
    if (railTab !== 'circuits') return [] as CircuitRecord[];
    const query = railSearch.trim().toLowerCase();
    if (!query) return circuits;
    return circuits.filter((record) => [record.id, record.name ?? '', record.qasm].join(' ').toLowerCase().includes(query));
  }, [circuits, railSearch, railTab]);

  const visibleStart = Math.max(0, Math.floor(viewport.scrollLeft / (metrics.colWidth * zoom)) - 2);
  const visibleEnd = Math.min(circuit.layers.length - 1, Math.ceil((viewport.scrollLeft + viewport.width) / (metrics.colWidth * zoom)) + 2);

  const visibleLayers = useMemo(() => {
    const values: Array<{ layerIndex: number; op: EditableGate }> = [];
    if (!circuit.layers.length) return values;
    for (let layerIndex = visibleStart; layerIndex <= visibleEnd; layerIndex += 1) {
      (circuit.layers[layerIndex] ?? []).forEach((op) => values.push({ layerIndex, op }));
    }
    return values;
  }, [circuit.layers, visibleEnd, visibleStart]);

  const histogram = (selectedJob?.derived?.distribution ?? []).slice(0, 18);
  const qasmCode = useMemo(() => circuitToOpenQasm(circuit), [circuit]);
  const qiskitCode = useMemo(() => circuitToQiskitSketch(circuit), [circuit]);
  const jsonCode = useMemo(() => JSON.stringify(toGatePayload(circuit), null, 2), [circuit]);
  const qasmSynced = !qasmDirty && qasmDraft === qasmCode;

  useEffect(() => {
    if (!qasmDirty) {
      setQasmDraft(qasmCode);
    }
  }, [qasmCode, qasmDirty]);

  return (
    <main className="studio-root">
      <header className="studio-topbar">
        <div>
          <p className="studio-eyebrow">Quantum Sandbox Studio</p>
          <h1>Composer-grade visual loop for AI-generated circuits</h1>
          <p className="studio-subtitle">Design circuits visually, inspect synchronized code, and rerun instantly on Qiskit Aer.</p>
        </div>
        <div className="studio-top-actions">
          <button type="button" className="studio-button" onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>
            {theme === 'light' ? 'Dark mode' : 'Light mode'}
          </button>
          <button type="button" className="studio-button" onClick={() => void refreshHistory()}>
            Refresh data
          </button>
          <label className="studio-toggle">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            Auto refresh
          </label>
        </div>
      </header>

      {error ? <div className="studio-banner studio-banner-error">{error}</div> : null}

      <div className="studio-shell">
        <aside className="studio-left-column">
          <section className="studio-panel studio-operations-panel">
            <div className="studio-panel-header">
              <h2>Operations</h2>
              <p>Drag gates onto circuit wires.</p>
            </div>
            <div className="studio-palette-grid">
              {PALETTE.map((gate) => (
                <button
                  key={gate.key}
                  type="button"
                  className={`studio-palette-tile ${activePalette === gate.key ? 'active' : ''}`}
                  style={{ '--gate-color': gate.color } as CSSProperties}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('application/x-qs-gate', gate.key)}
                  onClick={() => setActivePalette((current) => (current === gate.key ? null : gate.key))}
                >
                  <strong>{gate.label}</strong>
                  <span>{gate.key.toUpperCase()}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="studio-panel studio-history-panel">
            <div className="studio-panel-header">
              <h2>History</h2>
              <div className="studio-segmented">
                <button type="button" className={railTab === 'jobs' ? 'active' : ''} onClick={() => setRailTab('jobs')}>
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
              placeholder={railTab === 'jobs' ? 'Search jobs…' : 'Search circuits…'}
              aria-label="Search history"
            />
            <div className="studio-history-list">
              {loadingHistory ? <p className="studio-muted">Loading history…</p> : null}
              {railTab === 'jobs'
                ? filteredJobs.map((job) => (
                    <button
                      key={job.id}
                      type="button"
                      className={`studio-history-item ${selectedJobId === job.id ? 'active' : ''}`}
                      onClick={() => void loadJob(job.id)}
                    >
                      <strong>{job.kind}</strong>
                      <span>{job.id.slice(0, 8)}</span>
                      <small>{job.status} · {formatDate(job.created_at)}</small>
                    </button>
                  ))
                : filteredCircuits.map((record) => (
                    <button key={record.id} type="button" className="studio-history-item" onClick={() => void loadCircuit(record)}>
                      <strong>{record.name ?? 'untitled circuit'}</strong>
                      <span>{record.id.slice(0, 8)}</span>
                      <small>
                        {record.num_qubits}q · {formatDate(record.updated_at)}
                      </small>
                    </button>
                  ))}
            </div>
          </section>
        </aside>

        <section className="studio-panel studio-canvas-panel">
          <div className="studio-panel-header studio-canvas-toolbar">
            <div>
              <h2>Circuit composer</h2>
              <p>
                {circuit.numQubits} qubits · {circuit.layers.length} layers · {selectedOperation ? `selected ${selectedOperation.op.gate.toUpperCase()}` : 'no gate selected'}
              </p>
            </div>
            <div className="studio-toolbar-group">
              <label>
                Shots
                <input
                  type="number"
                  min={1}
                  value={shots}
                  onChange={(event) => setShots(Math.max(1, Number(event.target.value) || 1))}
                />
              </label>
              <button type="button" className="studio-button studio-run-cta" onClick={() => void runCircuit()} disabled={runBusy}>
                {runBusy ? 'Running…' : 'Set up and run'}
              </button>
              <button type="button" className="studio-button" onClick={() => dispatchHistory({ type: 'undo' })} disabled={!canUndo}>
                Undo
              </button>
              <button type="button" className="studio-button" onClick={() => dispatchHistory({ type: 'redo' })} disabled={!canRedo}>
                Redo
              </button>
              <button type="button" className="studio-button" onClick={editSelectedParameter} disabled={!selectedOperation || !PARAMETRIC_GATES.has(selectedOperation.op.gate)}>
                Edit param
              </button>
              <button type="button" className="studio-button" onClick={removeSelectedGate} disabled={!selectedOperation}>
                Delete
              </button>
              <button type="button" className="studio-button" onClick={addQubit}>+ qubit</button>
              <button type="button" className="studio-button" onClick={removeQubit}>- qubit</button>
              <button type="button" className="studio-button" onClick={() => setZoom((z) => clamp(z / 1.2, 0.45, 2.4))}>-</button>
              <button type="button" className="studio-button" onClick={() => setZoom((z) => clamp(z * 1.2, 0.45, 2.4))}>+</button>
              <button type="button" className="studio-button" onClick={() => setZoom(1)}>Reset zoom</button>
              <button type="button" className="studio-button" onClick={resetCircuit}>Reset circuit</button>
            </div>
          </div>

          <div className="studio-canvas-meta">
            <span>Active placement: {activePalette ? activePalette.toUpperCase() : 'none'}</span>
            <span>
              Visible layers {Math.max(visibleStart + 1, 1)}-{Math.max(visibleEnd + 1, 1)}
            </span>
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
              style={{ width: `${Math.ceil(metrics.width * zoom)}px`, height: `${Math.ceil(metrics.height * zoom)}px` }}
            >
              <div
                className="studio-canvas-content"
                style={{
                  width: `${metrics.width}px`,
                  height: `${metrics.height}px`,
                  transform: `scale(${zoom})`,
                  ['--layer-step' as string]: `${metrics.colWidth}px`,
                  ['--layer-offset' as string]: `${metrics.leftPad + metrics.chipWidth / 2}px`,
                }}
              >
                {Array.from({ length: circuit.numQubits }).map((_, qubit) => (
                  <div
                    key={`q-wire-${qubit}`}
                    className="studio-wire"
                    style={{ left: `${metrics.leftPad - 14}px`, right: '20px', top: `${yForQubit(qubit)}px` }}
                  >
                    <span className="studio-wire-label">q[{qubit}]</span>
                  </div>
                ))}

                {Array.from({ length: circuit.numClbits }).map((_, clbit) => (
                  <div
                    key={`c-wire-${clbit}`}
                    className="studio-wire classical"
                    style={{ left: `${metrics.leftPad - 14}px`, right: '20px', top: `${yForClbit(clbit)}px` }}
                  >
                    <span className="studio-wire-label">c[{clbit}]</span>
                  </div>
                ))}

                {Array.from(measuredQubits).map((qubit) => (
                  <div
                    key={`q-end-measure-${qubit}`}
                    className="studio-wire-end-measure"
                    style={{ left: `${metrics.width - 28}px`, top: `${yForQubit(qubit) - 11}px` }}
                    aria-hidden="true"
                  >
                    M
                  </div>
                ))}

                {visibleLayers.map(({ layerIndex, op }) => {
                  const x = metrics.leftPad + layerIndex * metrics.colWidth;
                  const centerX = x + metrics.chipWidth / 2;
                  const gateColor = gateLookup(op.gate)?.color ?? '#7b8aa2';
                  const style = { '--gate-color': gateColor } as CSSProperties;
                  const selected = selectedOpId === op.id;

                  const qubitYs = op.qubits.map(yForQubit);
                  const clbitYs = op.clbits.map(yForClbit);
                  const connectorMin = Math.min(...qubitYs, ...(clbitYs.length ? clbitYs : [qubitYs[0] ?? 0]));
                  const connectorMax = Math.max(...qubitYs, ...(clbitYs.length ? clbitYs : [qubitYs[0] ?? 0]));

                  const dragAttrs = {
                    draggable: true,
                    onDragStart: (event: DragEvent<HTMLElement>) => {
                      event.dataTransfer.setData('application/x-qs-op', op.id);
                    },
                  };

                  const selectOp = (event: { stopPropagation: () => void }) => {
                    event.stopPropagation();
                    setSelectedOpId(op.id);
                  };

                  return (
                    <div key={op.id} className="studio-op-layer" style={style}>
                      {op.qubits.length > 1 ? (
                        <div
                          className="studio-op-connector"
                          style={{ left: `${centerX}px`, top: `${connectorMin}px`, height: `${connectorMax - connectorMin}px` }}
                        />
                      ) : null}

                      {op.gate === 'barrier' ? (
                        <button
                          type="button"
                          {...dragAttrs}
                          className={`studio-barrier ${selected ? 'selected' : ''}`}
                          style={{ left: `${centerX - 1}px`, top: `${connectorMin - 18}px`, height: `${connectorMax - connectorMin + 36}px` }}
                          onClick={selectOp}
                          aria-label="Barrier"
                        />
                      ) : null}

                      {op.gate === 'cx' && op.qubits.length === 2 ? (
                        <>
                          <div className="studio-control-dot" style={{ left: `${centerX - 4.5}px`, top: `${qubitYs[0] - 4.5}px` }} />
                          <button
                            type="button"
                            {...dragAttrs}
                            className={`studio-target-button ${selected ? 'selected' : ''}`}
                            style={{ left: `${centerX - 10}px`, top: `${qubitYs[1] - 10}px` }}
                            onClick={selectOp}
                            aria-label="CNOT"
                          />
                        </>
                      ) : null}

                      {op.gate === 'ccx' && op.qubits.length === 3 ? (
                        <>
                          <div className="studio-control-dot" style={{ left: `${centerX - 4.5}px`, top: `${qubitYs[0] - 4.5}px` }} />
                          <div className="studio-control-dot" style={{ left: `${centerX - 4.5}px`, top: `${qubitYs[1] - 4.5}px` }} />
                          <button
                            type="button"
                            {...dragAttrs}
                            className={`studio-target-button ${selected ? 'selected' : ''}`}
                            style={{ left: `${centerX - 10}px`, top: `${qubitYs[2] - 10}px` }}
                            onClick={selectOp}
                            aria-label="CCX"
                          />
                        </>
                      ) : null}

                      {op.gate === 'swap' && op.qubits.length === 2 ? (
                        <button
                          type="button"
                          {...dragAttrs}
                          className={`studio-swap-handle ${selected ? 'selected' : ''}`}
                          style={{ left: `${centerX - 8}px`, top: `${(qubitYs[0] + qubitYs[1]) / 2 - 8}px` }}
                          onClick={selectOp}
                          aria-label="Swap"
                        >
                          <span style={{ top: `${qubitYs[0] - ((qubitYs[0] + qubitYs[1]) / 2) - 8}px` }}>×</span>
                          <span style={{ top: `${qubitYs[1] - ((qubitYs[0] + qubitYs[1]) / 2) - 8}px` }}>×</span>
                        </button>
                      ) : null}

                      {op.gate === 'measure'
                        ? op.qubits.map((qubit, index) => {
                            const qubitY = yForQubit(qubit);
                            const clbit = op.clbits[index];
                            const clbitY = clbit === undefined ? null : yForClbit(clbit);
                            return (
                              <div key={`${op.id}-${qubit}`}>
                                <button
                                  type="button"
                                  {...dragAttrs}
                                  className={`studio-gate-chip measure ${selected ? 'selected' : ''}`}
                                  style={{ left: `${x}px`, top: `${qubitY - metrics.chipHeight / 2}px` }}
                                  onClick={selectOp}
                                >
                                  M
                                </button>
                                {clbitY !== null ? (
                                  <div
                                    className="studio-measure-link"
                                    style={{
                                      left: `${centerX}px`,
                                      top: `${Math.min(qubitY, clbitY)}px`,
                                      height: `${Math.abs(clbitY - qubitY)}px`,
                                    }}
                                  />
                                ) : null}
                              </div>
                            );
                          })
                        : null}

                      {op.gate === 'cz' && op.qubits.length === 2 ? (
                        <>
                          <div className="studio-control-dot" style={{ left: `${centerX - 4.5}px`, top: `${qubitYs[0] - 4.5}px` }} />
                          <button
                            type="button"
                            {...dragAttrs}
                            className={`studio-gate-chip ${selected ? 'selected' : ''}`}
                            style={{ left: `${x}px`, top: `${qubitYs[1] - metrics.chipHeight / 2}px` }}
                            onClick={selectOp}
                          >
                            Z
                          </button>
                        </>
                      ) : null}

                      {!['cx', 'ccx', 'swap', 'measure', 'barrier', 'cz'].includes(op.gate)
                        ? op.qubits.map((qubit) => (
                            <button
                              key={`${op.id}-${qubit}`}
                              type="button"
                              {...dragAttrs}
                              className={`studio-gate-chip ${selected ? 'selected' : ''}`}
                              style={{ left: `${x}px`, top: `${yForQubit(qubit) - metrics.chipHeight / 2}px` }}
                              onClick={selectOp}
                            >
                              <span>{op.gate.toUpperCase()}</span>
                              {op.params[0] !== undefined ? <small>{op.params[0].toFixed(2)}</small> : null}
                            </button>
                          ))
                        : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="studio-panel studio-code-panel">
          <div className="studio-panel-header">
            <div>
              <h2>OpenQASM editor</h2>
              <p>{qasmSynced ? 'Synced with circuit canvas.' : 'Unsaved edits in code pane.'}</p>
            </div>
            <div className="studio-toolbar-group">
              <div className="studio-segmented">
                <button type="button" className={codeTab === 'qasm' ? 'active' : ''} onClick={() => setCodeTab('qasm')}>
                  OpenQASM
                </button>
                <button type="button" className={codeTab === 'python' ? 'active' : ''} onClick={() => setCodeTab('python')}>
                  Qiskit
                </button>
                <button type="button" className={codeTab === 'json' ? 'active' : ''} onClick={() => setCodeTab('json')}>
                  Gates
                </button>
              </div>
              {codeTab === 'qasm' ? (
                <button type="button" className="studio-button" onClick={() => void applyQasmToCanvas()} disabled={qasmApplying || !qasmDirty}>
                  {qasmApplying ? 'Applying…' : 'Apply to canvas'}
                </button>
              ) : null}
              <button
                type="button"
                className="studio-button"
                onClick={() => copyText(codeTab === 'qasm' ? qasmDraft : codeTab === 'python' ? qiskitCode : jsonCode)}
              >
                Copy
              </button>
            </div>
          </div>
          {codeTab === 'qasm' ? (
            <div className="studio-code-editor-wrap">
              <textarea
                className="studio-code-editor"
                spellCheck={false}
                value={qasmDraft}
                onChange={(event) => {
                  setQasmDraft(event.target.value);
                  setQasmDirty(event.target.value !== qasmCode);
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void applyQasmToCanvas();
                  }
                }}
                aria-label="OpenQASM editor"
              />
              <p className="studio-code-hint">Tip: press Ctrl/Cmd + Enter to apply editor changes back onto the circuit canvas.</p>
            </div>
          ) : (
            <pre className="studio-code-scroll">{codeTab === 'python' ? qiskitCode : jsonCode}</pre>
          )}
        </section>

        <section className="studio-panel studio-viz-panel">
          <div className="studio-panel-header">
            <div>
              <h2>Visualizations</h2>
              <p>
                {selectedJob
                  ? `${selectedJob.kind} · ${selectedJob.backend ?? 'n/a'} · ${selectedJob.shots ?? 'n/a'} shots · ${formatDuration(selectedJob.derived?.duration_ms)}`
                  : 'Run or select a job to populate results.'}
              </p>
            </div>
            <div className="studio-toolbar-group">
              <label>
                Mode
                <select value={resultsMode} onChange={(event) => setResultsMode(event.target.value as ResultsMode)}>
                  <option value="counts">Counts</option>
                  <option value="probabilities">Probabilities</option>
                </select>
              </label>
            </div>
          </div>

          <div className="studio-viz-grid">
            <section className="studio-viz-card">
              <h3>Probabilities histogram</h3>
              <ResultsHistogram rows={histogram} mode={resultsMode} />
            </section>

            <section className="studio-viz-card">
              <h3>Top outcomes</h3>
              {selectedJob ? (
                <div className="studio-table-scroll">
                  <table className="studio-table">
                    <thead>
                      <tr>
                        <th>State</th>
                        <th>Count</th>
                        <th>Probability</th>
                      </tr>
                    </thead>
                    <tbody>
                      {histogram.map((row) => (
                        <tr key={row.basis_state}>
                          <td>{row.basis_state}</td>
                          <td>{row.count ?? '—'}</td>
                          <td>{(row.probability * 100).toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="studio-muted">No job loaded yet. Execute a run to fill this probability table.</p>
              )}
            </section>

            <section className="studio-viz-card">
              <h3>State view</h3>
              {selectedJob ? (
                <BlochPanel vectors={selectedJob.derived?.bloch_vectors} reason={selectedJob.derived?.bloch_unavailable_reason} />
              ) : (
                <p className="studio-muted">Bloch vectors appear when the selected job has statevector-derived data.</p>
              )}
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}
