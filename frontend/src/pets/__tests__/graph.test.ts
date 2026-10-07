import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PET_GRAPH_ID, ablateGraph, graphHash, loadPetGraph, parsePetGraph } from '../brain/graph';

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH_FILE = resolve(HERE, '../brain/malecns-dna02-128.json');
const ATTRIBUTION_FILE = resolve(HERE, '../../../public/pets/connectome-attribution.txt');

type GraphJson = {
  id: string;
  nodes: string[];
  transmitters: string[];
  edges: [number, number, number][];
  normalization: { incomingAbsSum: number };
  provenance: Record<string, unknown> & { derivedFrom: { sha256: string } };
  selection: { seedType: string; seedIds: string[]; inducedEdges: number; inducedSynapses: number };
};
const readJson = (): GraphJson => JSON.parse(readFileSync(GRAPH_FILE, 'utf8')) as GraphJson;

describe('펫 회로 데이터', () => {
  it('DNa02 주변 128개 뉴런과 연결 3,623개다', () => {
    const json = readJson();
    const graph = parsePetGraph(json);
    expect(graph.id).toBe(PET_GRAPH_ID);
    expect(graph.size).toBe(128);
    expect(graph.nodes).toHaveLength(128);
    expect(graph.sources).toHaveLength(3623);
    expect(graph.weights).toHaveLength(3623);
    expect(graph.offsets[128]).toBe(3623);
    expect(json.selection).toMatchObject({ seedType: 'DNa02', inducedEdges: 3623, inducedSynapses: 88_574 });
    expect(json.selection.seedIds).toEqual([json.nodes[0], json.nodes[1]]);
    expect(json.edges.reduce((sum, [, , synapses]) => sum + Math.abs(synapses), 0)).toBe(88_574);
  });

  it('뉴런마다 받는 가중치 절댓값 합이 0.8이다', () => {
    const json = readJson();
    // The file keeps signed synapse counts; the weight rule is applied exactly as the parser does.
    const totals = new Float64Array(128);
    for (const [, target, synapses] of json.edges) totals[target]! += Math.abs(synapses);
    const sums = new Float64Array(128);
    for (const [, target, synapses] of json.edges) sums[target]! += Math.abs((json.normalization.incomingAbsSum * synapses) / totals[target]!);
    for (const sum of sums) expect(Math.abs(sum - 0.8)).toBeLessThan(1e-9);

    const graph = parsePetGraph(json);
    for (let i = 0; i < graph.size; i++) {
      let sum = 0;
      for (let k = graph.offsets[i]!; k < graph.offsets[i + 1]!; k++) sum += Math.abs(graph.weights[k]!);
      expect(Math.abs(sum - 0.8)).toBeLessThan(1e-6);
    }
  });

  it('연결 부호는 보내는 뉴런의 신경전달물질 예측을 따른다', () => {
    const json = readJson();
    const sign = { ACh: 1, GABA: -1, Glu: -1 } as Record<string, number>;
    for (const [source, , synapses] of json.edges) expect(Math.sign(synapses)).toBe(sign[json.transmitters[source]!]);
    expect(json.edges.filter(([, , synapses]) => synapses < 0)).toHaveLength(1604);
  });

  it('출처를 함께 싣는다', () => {
    const { provenance } = readJson();
    expect(provenance['license']).toBe('CC-BY 4.0');
    expect(provenance['licenseUrl']).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(provenance['source']).toMatch(/^https:\/\/storage\.googleapis\.com\/flyem-male-cns\/v1\.0\//);
    expect(provenance['officialDatasetPage']).toBe('https://male-cns.janelia.org/download/');
    expect(provenance['sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance['version']).toBe('MaleCNS v1.0 (minconf 0.5)');
    expect(provenance['credit']).toContain('FlyEM (HHMI Janelia)');
    expect(provenance['note']).toContain('not a dog brain');
    expect(provenance.derivedFrom.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('화면에서 여는 출처 문서가 데이터셋, 만든 곳, 라이선스, 바꾼 점을 적는다', () => {
    const text = readFileSync(ATTRIBUTION_FILE, 'utf8');
    for (const needed of [
      'Male CNS connectome v1.0',
      'FlyEM',
      'HHMI Janelia',
      'CC BY 4.0',
      'https://creativecommons.org/licenses/by/4.0/',
      'https://male-cns.janelia.org/download/',
      'DNa02',
      '128',
      '3,623',
      '0.8',
      '강아지의 뇌가 아니',
      '대조군',
    ]) {
      expect(text).toContain(needed);
    }
    expect(text).not.toMatch(/\r/);
  });

  it('잘못된 회로는 받지 않는다', () => {
    const broken = (change: (json: GraphJson & Record<string, unknown>) => void) => {
      const json = readJson() as GraphJson & Record<string, unknown>;
      change(json);
      return () => parsePetGraph(json);
    };
    expect(() => parsePetGraph(null)).toThrow(TypeError);
    expect(broken((json) => (json['schema'] = 2))).toThrow(/schema/);
    expect(broken((json) => (json.nodes[1] = json.nodes[0]!))).toThrow(/duplicate nodes/);
    expect(broken((json) => json.transmitters.pop())).toThrow(/transmitters/);
    expect(broken((json) => (json.edges[0] = [0, 128, 5]))).toThrow(/edge range/);
    expect(broken((json) => (json.edges[0] = [0, 1, 2.5]))).toThrow(/edge values/);
    expect(broken((json) => (json.edges[0]![2] = -json.edges[0]![2]))).toThrow(/sign/);
    expect(broken((json) => json.edges.push([...json.edges[0]!]))).toThrow(/duplicate edge/);
    expect(broken((json) => (json.normalization.incomingAbsSum = Number.NaN))).toThrow(/normalization/);
    expect(broken((json) => (json.provenance['sha256'] = 'abc'))).toThrow(/sha256/);
    expect(broken((json) => (json.provenance['source'] = 'http://example.com/x'))).toThrow(/source/);
    expect(broken((json) => (json.provenance['license'] = 'CC0'))).toThrow(/license/);
    expect(broken((json) => delete json.provenance['note'])).toThrow(/note/);
  });

  it('대조군 회로는 연결 가중치만 0이다', () => {
    const graph = parsePetGraph(readJson());
    const control = ablateGraph(graph);
    expect(control.id).not.toBe(graph.id);
    expect(control.offsets).toBe(graph.offsets);
    expect(control.weights.every((weight) => weight === 0)).toBe(true);
    expect(graph.weights.some((weight) => weight !== 0)).toBe(true);
  });

  it('저장된 뇌가 싣는 회로 해시는 FNV-1a 32다', () => {
    // The server checks saved brains against this value (server/src/pets.rs).
    expect(graphHash(PET_GRAPH_ID)).toBe(0x7472dea7);
    expect(graphHash('')).toBe(0x811c9dc5);
    expect(graphHash('a')).toBe(0xe40c292c);
  });

  describe('불러오기', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('한 번 받아 검사하고 다시 쓰며, 실패한 응답은 넘기지 않는다', async () => {
      const fetchMock = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchMock);
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
      await expect(loadPetGraph()).rejects.toThrow(/503/);
      fetchMock.mockResolvedValueOnce(new Response(readFileSync(GRAPH_FILE, 'utf8'), { status: 200 }));
      const graph = await loadPetGraph();
      expect(graph.size).toBe(128);
      expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/malecns-dna02-128.*\.json/);
      expect(await loadPetGraph()).toBe(graph);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
