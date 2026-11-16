import {
  AnimationClip,
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  MeshStandardMaterial,
  Quaternion,
  QuaternionKeyframeTrack,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  type Object3D,
} from 'three';
import { describe, expect, it } from 'vitest';

import { clipsOf, DogRig, dogModelOf, idlePhase, tapMovesOf } from '../scene/dogModel';

// A rigged dog in miniature: a body and two arms, rigged with the arms straight out (the T-pose) as Meshy rigs, and
// clips that move the arms as the library's idle, wave and cheer do.

const Z = new Vector3(0, 0, 1);
/** An arm turned `degrees` about z from straight out: down at -80 on the left, up past level when positive. */
const turned = (degrees: number) => new Quaternion().setFromAxisAngle(Z, (degrees * Math.PI) / 180);
const track = (bone: string, times: number[], degrees: number[]) =>
  new QuaternionKeyframeTrack(`${bone}.quaternion`, times, degrees.flatMap((angle) => turned(angle).toArray()));

const IDLE = new AnimationClip('idle', 2, [track('armL', [0, 1, 2], [-80, -70, -80]), track('armR', [0, 1, 2], [80, 70, 80])]);
const WAVE = new AnimationClip('wave', 1, [track('armR', [0, 0.5, 1], [80, -20, 80])]);
const CHEER = new AnimationClip('cheer', 0.8, [track('armL', [0, 0.4, 0.8], [-80, 60, -80]), track('armR', [0, 0.4, 0.8], [80, -60, 80])]);
const WALK = new AnimationClip('walk', 1.2, [track('armL', [0, 1.2], [-80, -80])]);

/** The miniature dog's scene: arms out to either side, the whole of it 1.2 tall. */
function figure(): Object3D {
  const root = new Bone();
  root.name = 'root';
  const armL = new Bone();
  armL.name = 'armL';
  armL.position.set(0.15, 0.8, 0);
  const armR = new Bone();
  armR.name = 'armR';
  armR.position.set(-0.15, 0.8, 0);
  root.add(armL, armR);
  const geometry = new BufferGeometry();
  // Feet, head, then each arm's tip, out at the side.
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 1.2, 0, 0.65, 0.8, 0, -0.65, 0.8, 0], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
  mesh.add(root);
  mesh.bind(new Skeleton([root, armL, armR]));
  const scene = new Group();
  scene.add(mesh);
  return scene;
}

const boneOf = (scene: Object3D, name: string) => scene.getObjectByName(name)!;
/** How far, in degrees, a bone is turned from straight out. */
const angleOf = (scene: Object3D, name: string) => (boneOf(scene, name).quaternion.angleTo(new Quaternion()) * 180) / Math.PI;

describe('수호 강아지의 동작', () => {
  it('이름으로 동작을 고르고, idle이 없는 모델은 그대로 서 있다', () => {
    const clips = clipsOf([WALK, CHEER, IDLE, WAVE, new AnimationClip('Running', 1, [])]);
    expect(clips).toEqual({ idle: IDLE, cheer: CHEER, wave: WAVE, walk: WALK });
    expect(tapMovesOf(clips!)).toEqual(['wave', 'cheer']);
    expect(tapMovesOf({ idle: IDLE, cheer: CHEER })).toEqual(['cheer']);
    // A model that was never rigged, or whose clips are not the village's: it stands as it was modelled.
    expect(clipsOf([])).toBeNull();
    expect(clipsOf([new AnimationClip('Idle', 1, []), WAVE])).toBeNull();
  });

  it('처음 그려지는 순간부터 idle이다: T자 자세가 보이지 않는다', () => {
    const scene = figure();
    const rig = new DogRig(scene, { idle: IDLE, wave: WAVE, cheer: CHEER });
    rig.rest(0);
    expect(angleOf(rig.figure, 'armL')).toBeCloseTo(80, 3);
    expect(angleOf(rig.figure, 'armR')).toBeCloseTo(80, 3);
    // The model itself is left as it was rigged: every copy poses its own skeleton.
    expect(angleOf(scene, 'armL')).toBeCloseTo(0, 6);
    expect(boneOf(rig.figure, 'armL')).not.toBe(boneOf(scene, 'armL'));
    // From another place in its idle, counted round the idle's length.
    rig.rest(1 + 2 * 3);
    expect(angleOf(rig.figure, 'armL')).toBeCloseTo(70, 3);
    rig.dispose();
  });

  it('누르면 손을 흔들고, 끝나면 idle로 돌아가며, 다음에는 만세를 한다', () => {
    const rig = new DogRig(figure(), { idle: IDLE, wave: WAVE, cheer: CHEER });
    rig.rest(0);
    expect(rig.perform()).toBe('wave');
    expect(rig.performing).toBe('wave');
    // One move at a time.
    expect(rig.perform()).toBeNull();
    rig.advance(0.5);
    // Half way through the wave the right arm is raised past level, where the idle never takes it.
    expect(angleOf(rig.figure, 'armR')).toBeLessThan(40);
    rig.advance(0.55);
    expect(rig.performing).toBeNull();
    // Blended back into the idle from its start.
    rig.advance(0.4);
    expect(angleOf(rig.figure, 'armR')).toBeGreaterThan(70);
    expect(rig.perform()).toBe('cheer');
    rig.advance(0.4);
    expect(angleOf(rig.figure, 'armL')).toBeLessThan(70);
    rig.dispose();
  });

  it('붙잡힌 장면에서는 idle의 첫 장면에 서 있고, 다시 붙여도 움직인다', () => {
    const rig = new DogRig(figure(), { idle: IDLE });
    rig.rest(0);
    // A dog with no move of its own does nothing when tapped.
    expect(rig.perform()).toBeNull();
    rig.advance(0.6);
    expect(angleOf(rig.figure, 'armL')).toBeLessThan(79);
    // Let go of as React does with an effect it runs twice, and rested again: it still idles.
    rig.dispose();
    rig.rest(0);
    expect(angleOf(rig.figure, 'armL')).toBeCloseTo(80, 3);
    rig.advance(1);
    expect(angleOf(rig.figure, 'armL')).toBeCloseTo(70, 3);
    rig.dispose();
  });

  it('리깅된 모델은 idle 자세로 잰다; 리깅되지 않은 모델은 그대로 잰다', () => {
    const rigged = dogModelOf({ scene: figure(), animations: [IDLE, WAVE] });
    expect(rigged.clips?.idle).toBe(IDLE);
    // Arms down, it reaches far less to the side than in the T-pose it was rigged in (0.65).
    expect(rigged.halfWidth).toBeLessThan(0.3);
    expect(rigged.halfWidth).toBeGreaterThan(0.1);
    // The model is put back as it was rigged, for each copy to pose its own.
    expect(angleOf(rigged.scene, 'armL')).toBeCloseTo(0, 6);
    let shadows = 0;
    rigged.scene.traverse((object) => (shadows += (object as SkinnedMesh).isSkinnedMesh && object.castShadow ? 1 : 0));
    expect(shadows).toBe(1);
    const plain = dogModelOf({ scene: figure(), animations: [] });
    expect(plain.clips).toBeNull();
    expect(plain.halfWidth).toBeCloseTo(0.65, 3);
  });

  it('마을의 강아지들은 저마다 다른 때에 idle을 시작한다', () => {
    const phases = [
      [0, 0],
      [14, 0],
      [-14, 6],
      [7, -12],
    ].map(([x, z]) => idlePhase(x!, z!, 4));
    for (const phase of phases) {
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(4);
    }
    expect(new Set(phases.map((phase) => phase.toFixed(3))).size).toBe(phases.length);
    expect(idlePhase(14, 0, 4)).toBe(phases[1]);
  });
});

