#!/usr/bin/env node
/**
 * Exports the pets' circuit, src/pets/brain/malecns-dna02-128.json, from 초켓몬스터's browser subset of the MaleCNS
 * v1.0 connectome (same owner; that file was cut from the Janelia FlyEM release by its scripts/prepare-connectome.py).
 *
 *   node scripts/pets-export-graph.mjs <choketmon>/public/data/connectome.json [out.json]
 *
 * The subset is checked before anything is written: 128 neurons around the DNa02 pair, 3,623 edges, every neuron's
 * absolute incoming weights summing to 0.8, each weight equal to 0.8 × its signed synapse count over the target's
 * total, one transmitter sign per source neuron, and the provenance fields. The output keeps the measured synapse
 * counts with that sign and drops the weights (the brain derives them on load); it prints the sha256 of the input with
 * line endings as committed (LF) and of the output, so a re-export can be compared byte for byte.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '../src/pets/brain/malecns-dna02-128.json');
const EXPECTED = { id: 'malecns-v1.0-dna02-neighborhood-128', nodes: 128, edges: 3623, seedType: 'DNa02', incoming: 0.8 };
const TRANSMITTERS = { acetylcholine: 'ACh', gaba: 'GABA', glutamate: 'Glu' };
const SIGN = { ACh: 1, GABA: -1, Glu: -1 };
const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';
const CREDIT =
  'This project is a collaboration between FlyEM (HHMI Janelia), the University of Cambridge (Dept. of Zoology), the MRC Laboratory of Molecular Biology, and Google Research.';
const NOTE =
  'Induced subgraph around the bilateral DNa02 descending-neuron pair of MaleCNS v1.0, taken unchanged from the 초켓몬스터 browser subset: the seeds plus their strongest directly connected annotated partners (acetylcholine, GABA or glutamate predicted with confidence >= 0.5). ' +
  'Edges keep the measured synapse count with a sign from the source neuron\'s predicted transmitter (acetylcholine positive; GABA and glutamate negative), a coarse assumption, not receptor evidence; ' +
  'each weight is 0.8 x count / the target\'s total incoming count. ' +
  'The pets\' senses, input projection, rate dynamics, action readout, innate preferences and rewards are game design with no anatomical mapping. This is a small part of a fly nervous system, not a whole brain and not a dog brain.';

const fail = (why) => {
  console.error(`pets-export-graph: ${why}`);
  process.exit(1);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const [input, output = DEFAULT_OUT] = process.argv.slice(2);
if (!input) fail('usage: node scripts/pets-export-graph.mjs <choketmon>/public/data/connectome.json [out.json]');

// A Windows checkout may hold the file with CRLF; the export and its hash use the committed LF text.
const text = readFileSync(input, 'utf8').replace(/\r\n/g, '\n');
const source = JSON.parse(text);

if (source.schema !== 1 || source.kind !== 'connectome-subset' || source.id !== EXPECTED.id) fail('not the DNa02 subset');
const { nodes, edges, nodeMetadata, provenance, selection, sourceFiles, officialDatasetPage } = source;
if (!Array.isArray(nodes) || nodes.length !== EXPECTED.nodes || new Set(nodes).size !== nodes.length) fail('expected 128 unique nodes');
if (!nodes.every((id) => typeof id === 'string' && /^\d+$/.test(id))) fail('node ids must be body ids');
if (!Array.isArray(edges) || edges.length !== EXPECTED.edges) fail('expected 3,623 edges');
if (!Array.isArray(nodeMetadata) || nodeMetadata.length !== nodes.length || nodeMetadata.some((node, i) => node.id !== nodes[i])) fail('node metadata out of order');
if (selection?.seedType !== EXPECTED.seedType || selection.inducedEdges !== edges.length) fail('selection');

const transmitters = nodeMetadata.map((node) => TRANSMITTERS[node.neurotransmitter] ?? fail(`transmitter ${node.neurotransmitter}`));
const types = nodeMetadata.map((node) => (typeof node.type === 'string' && node.type ? node.type : fail('cell type')));

const p = provenance ?? {};
for (const key of ['source', 'version', 'license', 'sha256', 'note']) if (typeof p[key] !== 'string' || !p[key]) fail(`provenance.${key}`);
if (!/^https:\/\//.test(p.source) || !/^[0-9a-f]{64}$/.test(p.sha256) || p.license !== 'CC-BY 4.0') fail('provenance source, sha256 or license');
if (!/^https:\/\//.test(officialDatasetPage ?? '')) fail('officialDatasetPage');

const total = new Float64Array(nodes.length);
const incoming = new Float64Array(nodes.length);
const pairs = new Set();
for (const edge of edges) {
  const { source: s, target: t, weight, synapses } = edge;
  if (!Number.isInteger(s) || !Number.isInteger(t) || s < 0 || t < 0 || s >= nodes.length || t >= nodes.length) fail('edge index');
  if (!Number.isInteger(synapses) || synapses <= 0 || !Number.isFinite(weight) || weight === 0) fail('edge weight or synapses');
  if (Math.sign(weight) !== SIGN[transmitters[s]]) fail(`edge ${s}->${t} sign differs from ${transmitters[s]}`);
  if (pairs.has(`${s},${t}`)) fail('duplicate edge');
  pairs.add(`${s},${t}`);
  total[t] += synapses;
  incoming[t] += Math.abs(weight);
}
incoming.forEach((sum, i) => Math.abs(sum - EXPECTED.incoming) <= 1e-9 || fail(`node ${i} receives |w| ${sum}, not 0.8`));
for (const { source: s, target: t, weight, synapses } of edges) {
  const derived = (EXPECTED.incoming * Math.sign(weight) * synapses) / total[t];
  if (Math.abs(derived - weight) > 1e-12) fail(`edge ${s}->${t}: weight is not 0.8 x synapses / incoming synapses`);
}

const graph = {
  schema: 1,
  kind: 'connectome-subset',
  id: source.id,
  nodes,
  types,
  transmitters,
  edgeFormat: '[source index, target index, signed synapse count]',
  edges: edges.map(({ source: s, target: t, weight, synapses }) => [s, t, Math.sign(weight) * synapses]),
  normalization: { incomingAbsSum: EXPECTED.incoming, rule: 'w = 0.8 x n / sum of |n| over the edges the target receives' },
  provenance: {
    dataset: 'Male CNS connectome v1.0',
    creator: 'FlyEM, HHMI Janelia Research Campus',
    credit: CREDIT,
    source: p.source,
    version: p.version,
    license: p.license,
    licenseUrl: LICENSE_URL,
    sha256: p.sha256,
    officialDatasetPage,
    note: NOTE,
    sourceFiles,
    derivedFrom: { project: '초켓몬스터', file: 'public/data/connectome.json', sha256: sha256(text), bytes: Buffer.byteLength(text) },
  },
  selection,
};

// One key a line and one edge list line keep the file small and its diffs readable.
const body = `{\n${Object.entries(graph)
  .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
  .join(',\n')}\n}\n`;
writeFileSync(output, body);
console.log(`input   sha256 ${sha256(text)} (${Buffer.byteLength(text)} bytes, LF)`);
console.log(`output  sha256 ${sha256(body)} (${Buffer.byteLength(body)} bytes) ${output}`);
console.log(`${graph.nodes.length} nodes, ${graph.edges.length} edges, ${edges.reduce((sum, edge) => sum + edge.synapses, 0)} synapses`);
