import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DOGS, dogOf, sexagenaryIndex } from '../dogs';
import { BRANCHES, STEMS, stemElement } from '../elements';

type Gltf = {
  skins?: { joints: number[] }[];
  animations?: { name: string }[];
  meshes: { primitives: { indices?: number; attributes: Record<string, number> }[] }[];
  accessors: { count: number }[];
};

/** A binary glTF's JSON chunk. */
const gltfOf = (bytes: Buffer): Gltf => JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8')) as Gltf;
const trianglesOf = (gltf: Gltf) =>
  gltf.meshes.flatMap((mesh) => mesh.primitives).reduce((sum, primitive) => sum + gltf.accessors[primitive.indices ?? primitive.attributes['POSITION']!]!.count / 3, 0);
/** scripts/guardians/models.json: which dogs' rigs held. */
const RIGGED = new Set((JSON.parse(readFileSync(resolve(__dirname, '../../../../scripts/guardians/models.json'), 'utf8')) as { rigged?: string[] }).rigged ?? []);

/** The sixty pillars in order: 甲子, 乙丑, … 癸亥. */
const SIXTY = Array.from({ length: 60 }, (_, index) => ({ stem: STEMS[index % 10]!, branch: BRANCHES[index % 12]! }));
/** 삼합: the branches four apart. */
const triadOf = (branch: string) => BRANCHES.indexOf(branch) % 4;

describe('수호 강아지', () => {
  it('육십갑자의 자리를 센다', () => {
    expect(SIXTY.map(({ stem, branch }) => sexagenaryIndex(stem, branch))).toEqual(Array.from({ length: 60 }, (_, index) => index));
    // 양간은 음지를 만나지 않는다.
    expect(sexagenaryIndex('甲', '丑')).toBe(-1);
    expect(sexagenaryIndex('?', '子')).toBe(-1);
  });

  it('스무 마리가 일주를 셋씩 맡는다: 한 천간과 한 삼합', () => {
    expect(new Set(DOGS.map((dog) => dog.id))).toEqual(new Set(Array.from({ length: 20 }, (_, index) => String(index + 1).padStart(2, '0'))));
    expect(new Set(DOGS.map((dog) => dog.name)).size).toBe(20);
    const kept = new Map<string, { stem: string; branch: string }[]>();
    for (const pillar of SIXTY) {
      const { id } = dogOf(pillar.stem, pillar.branch);
      kept.set(id, [...(kept.get(id) ?? []), pillar]);
    }
    expect(kept.size).toBe(20);
    for (const pillars of kept.values()) {
      expect(pillars).toHaveLength(3);
      expect(new Set(pillars.map((pillar) => pillar.stem)).size).toBe(1);
      expect(new Set(pillars.map((pillar) => triadOf(pillar.branch))).size).toBe(1);
      expect(new Set(pillars.map((pillar) => pillar.branch)).size).toBe(3);
    }
  });

  it('오행마다 네 마리다', () => {
    const count: Record<string, Set<string>> = {};
    for (const { stem, branch } of SIXTY) (count[stemElement(stem)!] ??= new Set()).add(dogOf(stem, branch).id);
    expect(Object.fromEntries(Object.entries(count).map(([element, dogs]) => [element, [...dogs].sort()]))).toEqual({
      wood: ['04', '09', '12', '15'],
      fire: ['10', '11', '13', '20'],
      earth: ['05', '14', '16', '19'],
      metal: ['02', '06', '08', '17'],
      water: ['01', '03', '07', '18'],
    });
  });

  it('일주가 그 집의 강아지를 정한다', () => {
    expect(dogOf('甲', '子')).toEqual({ id: '04', name: '공룡 강아지' });
    expect(dogOf('丁', '酉')).toEqual({ id: '11', name: '왕관 강아지' });
    expect(dogOf('丁', '巳').id).toBe('11');
    expect(dogOf('壬', '辰').name).toBe('목도리 강아지');
    expect(dogOf('癸', '亥').name).toBe('솜사탕 강아지');
    // 읽을 수 없는 일주에도 강아지는 있다.
    expect(dogOf('?', '?')).toBe(DOGS[0]);
  });

  it('스무 마리 모두 모델이 있고 가볍다: 리깅된 강아지는 뼈대와 네 동작을, 나머지는 만든 그대로의 모습을 갖는다', () => {
    const ids = new Set(DOGS.map((dog) => dog.id));
    for (const id of RIGGED) expect(ids.has(id), `models.json rigged ${id}`).toBe(true);
    for (const { id } of DOGS) {
      const file = resolve(__dirname, '../../../public/gltf/guardians', `${id}.glb`);
      expect(existsSync(file), `public/gltf/guardians/${id}.glb`).toBe(true);
      const bytes = readFileSync(file);
      // A binary glTF, small enough for nine of them to arrive with a village.
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('glTF');
      const gltf = gltfOf(bytes);
      const clips = (gltf.animations ?? []).map((clip) => clip.name).sort();
      if (RIGGED.has(id)) {
        expect(gltf.skins, id).toHaveLength(1);
        expect(clips, id).toEqual(['cheer', 'idle', 'walk', 'wave']);
        expect(trianglesOf(gltf), id).toBeLessThanOrEqual(10_500);
        expect(bytes.length, id).toBeLessThanOrEqual(450_000);
      } else {
        // A dog whose rig did not hold, or that was never rigged, keeps the model it was made as.
        expect(gltf.skins ?? [], id).toEqual([]);
        expect(clips, id).toEqual([]);
        expect(bytes.length, id).toBeLessThan(260_000);
      }
    }
  });
});

