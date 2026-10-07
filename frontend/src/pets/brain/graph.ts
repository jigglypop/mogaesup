import graphUrl from './malecns-dna02-128.json?url';

/**
 * The pets' circuit: 128 neurons around the DNa02 descending-neuron pair of the MaleCNS v1.0 fly connectome (Janelia
 * FlyEM, CC BY 4.0), the browser subset 초켓몬스터 made (same owner), re-exported by `scripts/pets-export-graph.mjs`.
 * The file keeps each edge's measured synapse count with the sign its source neuron's predicted transmitter gives
 * (acetylcholine +, GABA and glutamate −, an assumption); the weight is that count normalised so the absolute weights
 * a neuron receives sum to 0.8. Edges are stored by target (CSR) for the recurrent step.
 */
export type PetGraphProvenance = {
  source: string;
  version: string;
  license: string;
  licenseUrl: string;
  sha256: string;
  note: string;
  officialDatasetPage: string;
};

export type PetGraph = {
  readonly id: string;
  /** Neurons. */
  readonly size: number;
  /** Body ids, in index order. */
  readonly nodes: readonly string[];
  /** Incoming edges of neuron i are offsets[i]..offsets[i+1]−1 of `sources` and `weights`. */
  readonly offsets: Uint32Array;
  readonly sources: Uint16Array;
  readonly weights: Float32Array;
  readonly provenance: Readonly<PetGraphProvenance>;
};

/** The graph the pets use; the server checks saved brains against its hash (`graphHash`). */
export const PET_GRAPH_ID = 'malecns-v1.0-dna02-neighborhood-128';

const TRANSMITTER_SIGN: Record<string, number> = { ACh: 1, GABA: -1, Glu: -1 };
const MAX_NODES = 512;
const MAX_EDGES = 50_000;
const MAX_SYNAPSES = 10_000_000;
const HTTPS = /^https:\/\/\S+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GRAPH_ID = /^[a-z0-9][a-z0-9.+_-]{0,127}$/;

function fail(why: string): never {
  throw new TypeError(`Invalid pet graph: ${why}`);
}
const text =(value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Checks the exported JSON and turns it into the CSR the brain steps; throws on anything malformed. */
export function parsePetGraph(value: unknown): PetGraph {
  if (!value || typeof value !== 'object') fail('not an object');
  const json = value as Record<string, unknown>;
  if (json['schema'] !== 1 || json['kind'] !== 'connectome-subset') fail('schema');
  const id = json['id'];
  if (typeof id !== 'string' || !GRAPH_ID.test(id)) fail('id');

  const nodes = json['nodes'];
  if (!Array.isArray(nodes) || nodes.length < 2 || nodes.length > MAX_NODES || !nodes.every(text)) fail('nodes');
  const size = (nodes as string[]).length;
  if (new Set(nodes).size !== size) fail('duplicate nodes');
  const transmitters = json['transmitters'];
  if (!Array.isArray(transmitters) || transmitters.length !== size) fail('transmitters');
  const signs = (transmitters as unknown[]).map((name) => (typeof name === 'string' ? TRANSMITTER_SIGN[name] : undefined));
  if (signs.some((sign) => sign === undefined)) fail('transmitter names');

  const normalization = json['normalization'] as Record<string, unknown> | undefined;
  const total = normalization?.['incomingAbsSum'];
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0 || total > 1) fail('normalization');

  const edges = json['edges'];
  if (!Array.isArray(edges) || edges.length < 1 || edges.length > MAX_EDGES) fail('edges');
  const pairs = new Set<number>();
  const incoming = new Float64Array(size);
  const counts = new Uint32Array(size);
  for (const edge of edges as unknown[]) {
    if (!Array.isArray(edge) || edge.length !== 3) fail('edge shape');
    const [source, target, synapses] = edge as unknown[];
    if (!Number.isInteger(source) || !Number.isInteger(target) || !Number.isInteger(synapses)) fail('edge values');
    const s = source as number;
    const t = target as number;
    const n = synapses as number;
    if (s < 0 || s >= size || t < 0 || t >= size || n === 0 || Math.abs(n) > MAX_SYNAPSES) fail('edge range');
    if (Math.sign(n) !== signs[s]) fail('edge sign differs from its source transmitter');
    const pair = s * MAX_NODES + t;
    if (pairs.has(pair)) fail('duplicate edge');
    pairs.add(pair);
    incoming[t]! += Math.abs(n);
    counts[t]!++;
  }

  const provenance = json['provenance'] as Record<string, unknown> | undefined;
  if (!provenance || typeof provenance !== 'object') fail('provenance');
  const p = provenance as Record<string, unknown>;
  if (!text(p['source']) || !HTTPS.test(p['source'] as string)) fail('provenance source');
  if (!text(p['officialDatasetPage']) || !HTTPS.test(p['officialDatasetPage'] as string)) fail('provenance page');
  if (!text(p['licenseUrl']) || !HTTPS.test(p['licenseUrl'] as string)) fail('provenance license URL');
  if (p['license'] !== 'CC-BY 4.0') fail('provenance license');
  if (typeof p['sha256'] !== 'string' || !SHA256.test(p['sha256'])) fail('provenance sha256');
  if (!text(p['version']) || !text(p['note'])) fail('provenance version or note');

  // CSR by target, sources ascending within a target, so the recurrent sums run in one fixed order.
  const offsets = new Uint32Array(size + 1);
  for (let i = 0; i < size; i++) offsets[i + 1] = offsets[i]! + counts[i]!;
  const sorted = (edges as [number, number, number][]).slice().sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const sources = new Uint16Array(sorted.length);
  const weights = new Float32Array(sorted.length);
  sorted.forEach(([source, target, synapses], index) => {
    sources[index] = source;
    weights[index] = (total * synapses) / incoming[target]!;
  });

  return {
    id: id as string,
    size,
    nodes: Object.freeze((nodes as string[]).slice()),
    offsets,
    sources,
    weights,
    provenance: Object.freeze({
      source: p['source'] as string,
      version: p['version'] as string,
      license: p['license'] as string,
      licenseUrl: p['licenseUrl'] as string,
      sha256: p['sha256'] as string,
      note: p['note'] as string,
      officialDatasetPage: p['officialDatasetPage'] as string,
    }),
  };
}

/** The same graph with every connection removed: the control that shows what the circuit itself changes. */
export function ablateGraph(graph: PetGraph): PetGraph {
  return { ...graph, id: `${graph.id}+ablated`, weights: new Float32Array(graph.weights.length) };
}

/** FNV-1a 32 of the graph id's UTF-8 bytes; a saved brain carries it. */
export function graphHash(id: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(id)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash >>> 0;
}

const LOAD_TIMEOUT_MS = 20_000;
let loaded: PetGraph | null = null;

/** Fetches (once per page) and checks the circuit; the file has a hashed name and is only fetched where a pet lives. */
export async function loadPetGraph(signal?: AbortSignal): Promise<PetGraph> {
  if (loaded) return loaded;
  const timeout = AbortSignal.timeout(LOAD_TIMEOUT_MS);
  const response = await fetch(graphUrl, {
    signal: signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : (signal ?? timeout),
  });
  if (!response.ok) throw new Error(`Pet graph: HTTP ${response.status}`);
  const graph = parsePetGraph(await response.json());
  loaded ??= graph;
  return loaded;
}
