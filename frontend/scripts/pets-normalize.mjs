// Turns the character studio's finished dogs into island pet breeds: public/gltf/pets/<slug>.glb, its picture
// public/gltf/pets/<slug>.webp and the list src/pets/breeds.json the app reads.
//
// Input: a folder with one sub-folder per studio animal, named by its 24-hex id, holding the studio's own files
// (library/animals/<id>/ in the studio bucket, read only):
//   record.json            the studio record: Korean name, species, stages and each file's sha256
//   motions-standard.glb   the dog with the standard skeleton and its seven in-place clips
//   front.png              the front view the dog was modelled from (the picture)
//   aws s3 cp s3://<studio bucket>/assets/avatar-factory/1/library/animals/<id>/<file> <folder>/<id>/<file>
//
// Each model is checked (the studio's sha256, the 24 standard joints, the seven clips and their lengths, facing +Z as
// the engine's NPCs do), stood on the origin at HEIGHT metres in the first frame of `idle` (the pose the engine
// measures a template's `height` in, ears and hats included), centred between its paws and given two looping clips
// the studio does not make: `sit_hold` and `lie_hold`, the middle of the hold in `sit` and `lie` as a still pose.
// Channels that move nothing are dropped, materials become matte (the engine's 'figure' policy drops metal and gloss
// anyway), the colour map becomes 1024 px WebP and the normal map 512 px, the metal-rough map goes, and geometry and
// clips are meshopt-compressed (EXT_meshopt_compression, which the engine's GLTF loader decodes). Every written file
// is read back and checked again. The skin under each ankle follows the paw (SOLE), so a planted paw stays flat on the
// ground however the leg above it leans. The studio's walk and run step 2–5 cm in place; they are made again with
// longer steps and shorter cycles (GAITS) so the paws keep up with the island's speeds. The studio's sit, lie and jump
// push these round, short-legged dogs into the ground; those clips are corrected so no point of the dog is lower than
// 3 mm below it, on every key and between keys (GROUNDED); the run warns about a dog whose sit or lie could only clear
// the ground nearly standing (KEPT).
//
// breeds.json lists, in the studio's order: slug, name (Korean), source (studio id), order, model and thumbnail
// (paths the app serves), sha256 and bytes of the model, height_m / length_m / width_m in the first frame of idle,
// stride_mps (the ground speed at which walk and run, played at 1x, keep planted paws still) and clips (seconds).
//
// Usage: node scripts/pets-normalize.mjs <folder> [ids...]   (default: every dog in the folder that is not EXCLUDED)
// PETS_OUTPUT=<dir> writes <dir>/public/gltf/pets and <dir>/src/pets/breeds.json instead of this app's.
// A run over some ids keeps the other breeds already in breeds.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = process.env['PETS_OUTPUT'] ? resolve(process.env['PETS_OUTPUT']) : frontend;
const modelDir = join(outputRoot, 'public/gltf/pets');
const manifestPath = join(outputRoot, 'src/pets/breeds.json');

/** Metres from the ground to the top of the ears or hat in the first frame of `idle`: the design's template height. */
const HEIGHT = 0.55;
/** The studio's clips (backend/src/services/animal_standard_rig_blender.py), in seconds, all in place at 24 fps. */
const CLIPS = { walk: 1, run: 0.5, idle: 2, bark: 1, jump: 1.5, sit: 2, lie: 2 };
/** Still loops cut from the middle of the hold in `sit` (hold 0.5–1.5 s) and `lie` (hold 0.6–1.6 s). */
const HOLDS = [
  { name: 'sit_hold', from: 'sit', at: 1.0, seconds: 2 },
  { name: 'lie_hold', from: 'lie', at: 1.1, seconds: 3 },
];
const JOINTS = [
  'root', 'pelvis', 'spine_1', 'spine_2', 'chest', 'neck', 'head', 'ear_L', 'ear_R', 'tail_1', 'tail_2', 'tail_3',
  'fore_upper_L', 'fore_lower_L', 'fore_paw_L', 'fore_upper_R', 'fore_lower_R', 'fore_paw_R',
  'hind_upper_L', 'hind_lower_L', 'hind_paw_L', 'hind_upper_R', 'hind_lower_R', 'hind_paw_R',
];
const PAWS = ['fore_paw_L', 'fore_paw_R', 'hind_paw_L', 'hind_paw_R'];
/** Upper, lower and paw joint of each leg. */
const LEGS = ['fore_L', 'fore_R', 'hind_L', 'hind_R'].map((leg) => {
  const [limb, side] = leg.split('_');
  return [`${limb}_upper_${side}`, `${limb}_lower_${side}`, `${limb}_paw_${side}`];
});
/**
 * Metres above the ankle over which the skin goes from following the leg to following the paw. The studio's weights
 * leave much of each sole on the thigh and shin bones, so a leaning leg tipped the sole into the ground (the heel up
 * to 2 cm deep at a step's end). The skin below the ankle now moves with the paw, which the clips keep level.
 */
const SOLE = 0.01;
/**
 * The island moves a pet at 1.6–7 m/s (12 to keep up) at 1.5x this size, and the engine plays a move clip at most twice
 * as fast as it was made, so the studio's walk and run (in place, paws 2–5 cm a step, 1 s and 0.5 s a cycle; about
 * 0.04 and 0.15 m/s) slid. Both are made again from the studio's: the same footfall order (`phases`, a cycle's share
 * from 0 to 1) with each paw standing `duty` of a cycle, a shorter cycle (`seconds`), and the longest step, up to
 * `angle` degrees either side of the hip, the dog's legs reach and keep their skin out of the ground. Every standing
 * paw moves back at one speed (stride_mps), so at that ground speed the paws stand still. Head, ears and tail keep the
 * studio's motion at the new pace; the body rides the smoothest path that lets every leg reach (see `gait`).
 */
const GAITS = {
  walk: { seconds: 0.4, duty: 0.5, phases: { hind_L: 0, fore_L: 0.25, hind_R: 0.5, fore_R: 0.75 }, angle: 28, lift: 0.2 },
  run: { seconds: 0.3, duty: 0.35, phases: { fore_L: 0, hind_R: 0, fore_R: 0.5, hind_L: 0.5 }, angle: 36, lift: 0.3 },
};
/**
 * Keys a cycle; a paw in the air rises `lift` of the leg's height (at least `least`); a knee bends at most `bend`
 * degrees from how it stands and never quite straight (`straight` of its length); the body pitches at most `pitch`
 * radians (the head stays level) and the head rises and falls at most `bob` metres (more jiggles at the island's pace).
 */
const STEP = { keys: 24, least: 0.04, bend: 75, straight: 0.995, pitch: 0.05, bob: 0.02 };
/**
 * The studio lowers the body by most of the leg's length to sit, lie and crouch for a jump. These dogs' legs are short
 * and thick, with the thigh and upper arm about 7 cm long at HEIGHT, so the rump, belly, folded thighs and elbows go
 * 1–7 cm into the ground. These clips are put back above FLOOR metres frame by frame; idle keeps the studio's keys
 * (walk and run are made again, see GAITS). Lifting the body alone would take it back up to standing height, so the
 * body rises only as far as the belly needs (more only when nothing else works) and the legs are re-planted instead
 * (see `clearance`).
 */
const GROUNDED = ['sit', 'lie', 'jump', 'bark'];
const FLOOR = -0.003;
/** What the correction aims for, a little above FLOOR so the poses between keys and quantization stay above it. */
const AIM = -0.0015;
/** Keys a second in a corrected clip (the studio's 24, twice over, so the corrected motion holds between keys). */
const KEYS = 48;
/** A paw whose ankle is no more than this above its height in idle (or anywhere below it) stands on the ground. */
const PLANTED = 0.01;
/**
 * Where a clip may move its planted paws along the ground (+1 forward, -1 back) to fold a leg out of the ground:
 * sitting, the hind paws come forward under the body; lying, the hind paws come forward under the belly and the front
 * paws tuck back under the chest. A clip with neither (a jump's crouch) crouches less instead (see `ground`).
 */
const REPLANT = {
  sit: { fore: 0, hind: 1 },
  lie: { fore: -1, hind: 1 },
  jump: { fore: 0, hind: 0 },
  bark: { fore: 0, hind: 0 },
};
const SLIDE = { step: 0.005, max: 0.15 };
const RAISES = [0, 0.005, 0.01];
/**
 * Body tilts (radians, nose-down first) tried before raising paws off the ground: the studio's sit leans the body back
 * so far that straight fore legs end short of the ground, and turning it a little forward about the pelvis puts them
 * down; a lie may need the chest a little higher (nose-up) for folded fore legs to fit under it.
 */
const TILTS = [0, 1, 2, 3, 4, 5, -1, -2, -3].map((degrees) => (degrees * Math.PI) / 180);
/** Extra lift is tried `step` at a time up to `max`, and changes by at most `rate` from one key to the next. */
const LIFT = { step: 0.0025, max: 0.1, rate: 0.0025 };
/**
 * The least share of how far the studio lowered the body that a re-planted sit or lie must keep; below it the clip
 * crouches less instead (see `ground`) and the run warns. The studio's leg finder cuts some fluffy dogs' lower leg bones
 * to 0.8 cm; those legs cannot fold, and their sit and lie only clear the ground nearly standing until re-rigged.
 */
const KEPT = 1 / 3;
/** The joints that make a crouch, and how fast (share of the way to standing per key) a crouch may be made shallower. */
const POSTURE = ['pelvis', 'spine_1', 'spine_2', 'chest', 'neck', 'head'];
const SHARE_RATE = 0.08;
/** The dog stands about 0.8 m tall on the island. Its eyes and mouth are a small corner of the colour map: at 512 px
 *  they smear into blobs at the closest zoom, at 1024 px they keep their shape. Relief survives 512 px. */
const COLOR_MAP = { resize: [1024, 1024], quality: 86, slots: /^baseColorTexture$/ };
const NORMAL_MAP = { resize: [512, 512], quality: 86, slots: /^normalTexture$/ };
/** Breed pictures: the front view trimmed of its margin, fitted in `fit` px, centred on a clear `size` px square. */
const PICTURE = { size: 256, fit: 240, webp: { quality: 82, effort: 6 } };
/** File names by the studio's Korean name. A new breed needs a line here. */
const SLUGS = {
  웰시코기: 'welsh-corgi', 보더콜리: 'border-collie', 시베리안허스키: 'siberian-husky', 프렌치불독: 'french-bulldog',
  치와와: 'chihuahua', 달마시안: 'dalmatian', 코카스파니엘: 'cocker-spaniel', 퍼그: 'pug', 불독: 'bulldog',
  말티즈: 'maltese', 슈나우저: 'schnauzer', 사모예드: 'samoyed', 비숑프리제: 'bichon-frise', 푸들: 'poodle',
  포메라니안: 'pomeranian', 비글: 'beagle', 골든리트리버: 'golden-retriever', 파피용: 'papillon', 시바견: 'shiba-inu',
  닥스훈트: 'dachshund',
};
/** Dogs looked at and left out, by studio id. */
const EXCLUDED = {
  b1c5303060ac213f43929210: '비글: the beret is skinned partly to the body, so its back stretches out behind the head in idle, sit, lie and jump',
};

// --- Matrices (column-major, as glTF) and channel sampling -------------------------------------------------------

function compose([tx, ty, tz], [x, y, z, w], [sx, sy, sz]) {
  const [x2, y2, z2] = [x + x, y + y, z + z];
  const [xx, xy, xz, yy, yz, zz, wx, wy, wz] = [x * x2, x * y2, x * z2, y * y2, y * z2, z * z2, w * x2, w * y2, w * z2];
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a, b) {
  const out = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

/** The inverse of a matrix's 3x3 part, column-major: turns a world direction into the node's own axes. */
function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const rows = [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
  return (v) => rows.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
}

// Quaternions are [x, y, z, w], as glTF stores them.
const qmul = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const qinv = ([x, y, z, w]) => [-x, -y, -z, w];
/** `turn` expressed in the frame `frame` rotates into: frame⁻¹ · turn · frame. */
const within = (frame, turn) => qmul(qmul(qinv(frame), turn), frame);
const aboutX = (angle) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));

function slerp(a, b, u) {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  if (dot > 0.9995) {
    const q = a.map((value, i) => value + (sign * b[i] - value) * u);
    const length = Math.hypot(...q);
    return q.map((value) => value / length);
  }
  const angle = Math.acos(dot);
  const [wa, wb] = [Math.sin((1 - u) * angle) / Math.sin(angle), (sign * Math.sin(u * angle)) / Math.sin(angle)];
  return a.map((value, i) => wa * value + wb * b[i]);
}

/** A channel's value at `t` seconds (STEP or LINEAR; the studio writes no cubic splines). */
function sample(channel, t) {
  const sampler = channel.getSampler();
  const times = sampler.getInput().getArray();
  const output = sampler.getOutput();
  const interpolation = sampler.getInterpolation();
  if (interpolation === 'CUBICSPLINE') throw new Error(`cubic spline channel on ${channel.getTargetNode()?.getName()}`);
  const at = (i) => output.getElement(i, []);
  if (t <= times[0]) return at(0);
  const last = times.length - 1;
  if (t >= times[last]) return at(last);
  let i = 0;
  while (times[i + 1] <= t) i++;
  if (interpolation === 'STEP') return at(i);
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  const [a, b] = [at(i), at(i + 1)];
  return channel.getTargetPath() === 'rotation' ? slerp(a, b, u) : a.map((value, k) => value + (b[k] - value) * u);
}

/** Every node's translation, rotation and scale with `animation` played to `t` (the rest pose without one). */
function localsAt(document, animation, t) {
  const locals = new Map();
  for (const node of document.getRoot().listNodes()) {
    locals.set(node, { translation: node.getTranslation(), rotation: node.getRotation(), scale: node.getScale() });
  }
  for (const channel of animation?.listChannels() ?? []) {
    const node = channel.getTargetNode();
    const path = channel.getTargetPath();
    if (node && (path === 'translation' || path === 'rotation' || path === 'scale')) locals.get(node)[path] = sample(channel, t);
  }
  return locals;
}

/** World matrices of every node in the scene from its locals. */
function worldOf(document, locals) {
  const world = new Map();
  const visit = (node, parent) => {
    const { translation, rotation, scale } = locals.get(node);
    const matrix = multiply(parent, compose(translation, rotation, scale));
    world.set(node, matrix);
    for (const child of node.listChildren()) visit(child, matrix);
  };
  const identity = compose([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  for (const node of sceneOf(document).listChildren()) visit(node, identity);
  return world;
}

/** World matrices of every node with `animation` played to `t`. */
const pose = (document, animation, t) => worldOf(document, localsAt(document, animation, t));

/** A node's rotation in the scene (nothing above the joints rotates more than they do; the fit node only scales). */
function worldRotation(locals, node) {
  let rotation = [0, 0, 0, 1];
  for (let at = node; at; at = at.getParentNode()) rotation = qmul(locals.get(at).rotation, rotation);
  return rotation;
}

const sceneOf = (document) => document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
const clipOf = (document, name) => document.getRoot().listAnimations().find((animation) => animation.getName() === name);
const durationOf = (animation) => Math.max(...animation.listSamplers().map((sampler) => sampler.getInput().getMax([])[0]));

/**
 * The skinned mesh read once, so it can be posed often: `box(world)` puts every vertex through its joints, as three.js
 * and the engine draw it (glTF skinning: the joints' world matrices times the inverse binds).
 */
function skinningOf(document) {
  const node = document.getRoot().listNodes().find((candidate) => candidate.getSkin() && candidate.getMesh());
  const skin = node.getSkin();
  const joints = skin.listJoints();
  const inverseBinds = joints.map((_, i) => skin.getInverseBindMatrices().getElement(i, []));
  const read = (accessor, size) => {
    const values = new Float64Array(accessor.getCount() * size);
    const element = [];
    for (let i = 0; i < accessor.getCount(); i++) {
      accessor.getElement(i, element);
      for (let k = 0; k < size; k++) values[i * size + k] = element[k];
    }
    return values;
  };
  const parts = node.getMesh().listPrimitives().map((primitive) => ({
    count: primitive.getAttribute('POSITION').getCount(),
    positions: read(primitive.getAttribute('POSITION'), 3),
    indices: read(primitive.getAttribute('JOINTS_0'), 4),
    weights: read(primitive.getAttribute('WEIGHTS_0'), 4),
  }));
  // Each vertex belongs to the leg whose joint weighs most on it (`fore_L`, ...) or to the torso (body, head, tail).
  const regions = new Map();
  parts.forEach(({ count, indices, weights }, part) => {
    for (let i = 0; i < count; i++) {
      let heaviest = 0;
      for (let k = 1; k < 4; k++) if (weights[i * 4 + k] > weights[i * 4 + heaviest]) heaviest = k;
      const joint = joints[indices[i * 4 + heaviest]].getName();
      const leg = /^(fore|hind)_(?:upper|lower|paw)_([LR])$/.exec(joint);
      const region = leg ? `${leg[1]}_${leg[2]}` : 'torso';
      if (!regions.has(region)) regions.set(region, parts.map(() => []));
      regions.get(region)[part].push(i);
    }
  });
  return {
    /** The lowest point of `region` (a leg like `hind_L`, or `torso`) in a pose. */
    lowest(world, region) {
      const matrices = joints.map((joint, i) => multiply(world.get(joint), inverseBinds[i]));
      let min = Infinity;
      parts.forEach(({ positions, indices, weights }, part) => {
        for (const i of regions.get(region)?.[part] ?? []) {
          const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
          let py = 0;
          for (let k = 0; k < 4; k++) {
            const w = weights[i * 4 + k];
            if (!w) continue;
            const m = matrices[indices[i * 4 + k]];
            py += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
          }
          if (py < min) min = py;
        }
      });
      return min;
    },
    box(world) {
      const matrices = joints.map((joint, i) => multiply(world.get(joint), inverseBinds[i]));
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (const { count, positions, indices, weights } of parts) {
        for (let i = 0; i < count; i++) {
          const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
          let [px, py, pz] = [0, 0, 0];
          for (let k = 0; k < 4; k++) {
            const w = weights[i * 4 + k];
            if (!w) continue;
            const m = matrices[indices[i * 4 + k]];
            px += w * (m[0] * x + m[4] * y + m[8] * z + m[12]);
            py += w * (m[1] * x + m[5] * y + m[9] * z + m[13]);
            pz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
          }
          if (px < min[0]) min[0] = px;
          if (py < min[1]) min[1] = py;
          if (pz < min[2]) min[2] = pz;
          if (px > max[0]) max[0] = px;
          if (py > max[1]) max[1] = py;
          if (pz > max[2]) max[2] = pz;
        }
      }
      return { min, max, size: max.map((value, axis) => value - min[axis]) };
    },
  };
}

const positionOf = (world, joint) => world.get(joint).slice(12, 15);

/** How fast a planted paw slides back under the body in an in-place gait: the ground speed the clip walks at. */
function strideSpeed(document, joints, clip) {
  const animation = clipOf(document, clip);
  const rate = 240;
  const frames = Math.round(durationOf(animation) * rate);
  const tracks = PAWS.map(() => []);
  for (let frame = 0; frame <= frames; frame++) {
    const world = pose(document, animation, frame / rate);
    PAWS.forEach((paw, i) => tracks[i].push(positionOf(world, joints[paw])));
  }
  const speeds = [];
  for (const track of tracks) {
    const low = Math.min(...track.map((point) => point[1]));
    const reach = Math.max(...track.map((point) => point[1])) - low;
    for (let frame = 0; frame < frames; frame++) {
      const [a, b] = [track[frame], track[frame + 1]];
      if (a[1] - low < 0.02 * reach + 1e-6 && b[1] - low < 0.02 * reach + 1e-6) speeds.push((a[2] - b[2]) * rate);
    }
  }
  speeds.sort((a, b) => a - b);
  return speeds.length ? speeds[Math.floor(speeds.length / 2)] : 0;
}

/** The lowest point of `animation`, 120 times a second over its keys and between them (a still hold is one pose). */
function lowestOf(document, skinning, animation) {
  const seconds = durationOf(animation);
  const samples = HOLDS.some((hold) => hold.name === animation.getName()) ? 0 : Math.round(seconds * 120);
  let min = Infinity;
  for (let sample = 0; sample <= samples; sample++) {
    min = Math.min(min, skinning.box(pose(document, animation, samples ? (sample / samples) * seconds : 0)).min[1]);
  }
  return min;
}

// --- Checks ------------------------------------------------------------------------------------------------------

/** The joints by name, or a reason the model is not the studio's standard dog (with `clips` lasting their seconds). */
function check(document, clips = CLIPS) {
  const root = document.getRoot();
  const skins = root.listSkins();
  if (skins.length !== 1) return { problem: `${skins.length} skins` };
  const skinned = root.listNodes().filter((node) => node.getSkin() && node.getMesh());
  if (skinned.length !== 1) return { problem: `${skinned.length} skinned meshes` };
  const joints = Object.fromEntries(skins[0].listJoints().map((joint) => [joint.getName(), joint]));
  const missing = JOINTS.filter((name) => !joints[name]);
  if (missing.length) return { problem: `missing joints ${missing.join(', ')}` };
  for (const [name, seconds] of Object.entries(clips)) {
    const animation = clipOf(document, name);
    if (!animation) return { problem: `no ${name} clip` };
    if (Math.abs(durationOf(animation) - seconds) > 1 / 48) return { problem: `${name} lasts ${durationOf(animation)} s, not ${seconds}` };
  }
  for (const primitive of skinned[0].getMesh().listPrimitives()) {
    if (!primitive.getAttribute('JOINTS_0') || !primitive.getAttribute('WEIGHTS_0') || primitive.getAttribute('JOINTS_1')) {
      return { problem: 'a primitive is not skinned with four weights a vertex' };
    }
  }
  return { joints };
}

/** Facing +Z (the engine turns NPCs by atan2(dx, dz)): head ahead of the pelvis, fore paws ahead of hind paws. */
function facesForward(world, joints) {
  const z = (name) => positionOf(world, joints[name])[2];
  return z('head') > z('pelvis') && z('fore_paw_L') > z('hind_paw_L') && z('fore_paw_R') > z('hind_paw_R');
}

// --- Steps -------------------------------------------------------------------------------------------------------

/**
 * Drops the channels that move nothing: a joint's translation, rotation or scale that every clip keys at the joint's
 * rest value (the studio's export keys all 72 for every clip, most of them still). A joint no clip animates stays at
 * rest, so playback is the same; the file loses about two thirds of its animation entries.
 */
function dropStillChannels(document) {
  const groups = new Map();
  for (const animation of document.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const key = `${document.getRoot().listNodes().indexOf(channel.getTargetNode())}:${channel.getTargetPath()}`;
      groups.set(key, [...(groups.get(key) ?? []), channel]);
    }
  }
  let dropped = 0;
  for (const channels of groups.values()) {
    const node = channels[0].getTargetNode();
    const path = channels[0].getTargetPath();
    const rest = { translation: node?.getTranslation(), rotation: node?.getRotation(), scale: node?.getScale() }[path];
    if (!rest) continue;
    const same = (value) => {
      const sign = path === 'rotation' && value.reduce((sum, component, i) => sum + component * rest[i], 0) < 0 ? -1 : 1;
      return value.every((component, i) => Math.abs(sign * component - rest[i]) <= 1e-5 * Math.max(1, Math.abs(rest[i])));
    };
    const still = channels.every((channel) => {
      const output = channel.getSampler().getOutput();
      for (let i = 0; i < output.getCount(); i++) if (!same(output.getElement(i, []))) return false;
      return true;
    });
    if (!still) continue;
    for (const channel of channels) {
      const sampler = channel.getSampler();
      channel.dispose();
      if (!sampler.listParents().some((parent) => parent.propertyType === 'AnimationChannel')) sampler.dispose();
      dropped++;
    }
  }
  return dropped;
}

/** The inverse of an affine column-major matrix. */
function invertAffine(m) {
  const turn = invert3(m);
  const columns = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(turn);
  const moved = turn(m.slice(12, 15)).map((value) => -value);
  return [...columns[0], 0, ...columns[1], 0, ...columns[2], 0, ...moved, 1];
}

/** `matrix` applied to a point (w = 1) or a direction (w = 0). */
const transform = (m, [x, y, z], w = 1) => [0, 1, 2].map((row) => m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row] * w);

/**
 * Binds each leg's sole to its paw (SOLE): a skin vertex of a leg whose height in the first frame of idle is below the
 * ankle moves the leg's thigh and shin weight to the paw, fading out over SOLE above the ankle. The changed vertex gets
 * the bind position and normal that its new weights carry to where the old ones put it, so the first frame of idle is
 * what it was to the micrometre, and in other poses the sole moves rigidly with the paw from there. Returns how many
 * vertices changed and how far the first frame of idle moved.
 */
function plantSoles(document, joints) {
  const node = document.getRoot().listNodes().find((candidate) => candidate.getSkin() && candidate.getMesh());
  const skin = node.getSkin();
  const list = skin.listJoints();
  const index = new Map(list.map((joint, i) => [joint, i]));
  const standing = pose(document, clipOf(document, 'idle'), 0);
  const matrices = list.map((joint, i) => multiply(standing.get(joint), skin.getInverseBindMatrices().getElement(i, [])));
  const legs = LEGS.map(([upper, lower, paw]) => ({
    upper: index.get(joints[upper]),
    lower: index.get(joints[lower]),
    paw: index.get(joints[paw]),
    ankle: positionOf(standing, joints[paw])[1],
  }));
  const blend = (bones, weights) => {
    const out = new Array(16).fill(0);
    bones.forEach((bone, k) => {
      for (let e = 0; e < 16; e++) out[e] += weights[k] * matrices[bone][e];
    });
    return out;
  };
  let changed = 0;
  let moved = 0;
  for (const primitive of node.getMesh().listPrimitives()) {
    const [positions, normals, bones, weights] = ['POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0'].map((name) => primitive.getAttribute(name));
    const [position, normal, joint, weight] = [[], [], [], []];
    for (let v = 0; v < positions.getCount(); v++) {
      positions.getElement(v, position);
      bones.getElement(v, joint);
      weights.getElement(v, weight);
      let heaviest = 0;
      for (let k = 1; k < 4; k++) if (weight[k] > weight[heaviest]) heaviest = k;
      const leg = legs.find(({ upper, lower, paw }) => [upper, lower, paw].includes(joint[heaviest]));
      if (!leg) continue;
      const before = blend(joint, weight);
      const at = transform(before, position);
      const share = Math.min(1, Math.max(0, (leg.ankle + SOLE - at[1]) / SOLE));
      const smooth = share * share * (3 - 2 * share);
      const shares = new Map();
      joint.forEach((bone, k) => weight[k] && shares.set(bone, (shares.get(bone) ?? 0) + weight[k]));
      const taken = smooth * ((shares.get(leg.upper) ?? 0) + (shares.get(leg.lower) ?? 0));
      if (taken < 1e-4) continue;
      for (const bone of [leg.upper, leg.lower]) if (shares.has(bone)) shares.set(bone, shares.get(bone) * (1 - smooth));
      shares.set(leg.paw, (shares.get(leg.paw) ?? 0) + taken);
      const kept = [...shares].filter(([, w]) => w > 1e-4).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
      const total = kept.reduce((sum, [, w]) => sum + w, 0);
      const [newBones, newWeights] = [[0, 0, 0, 0], [0, 0, 0, 0]];
      kept.forEach(([bone, w], k) => {
        newBones[k] = bone;
        newWeights[k] = w / total;
      });
      const after = blend(newBones, newWeights);
      const back = invertAffine(after);
      const placed = transform(back, at);
      positions.setElement(v, placed);
      if (normals) {
        normals.getElement(v, normal);
        const turned = transform(back, transform(before, normal, 0), 0);
        const length = Math.hypot(...turned);
        normals.setElement(v, turned.map((value) => value / length));
      }
      bones.setElement(v, newBones);
      weights.setElement(v, newWeights);
      const check = transform(after, placed);
      moved = Math.max(moved, Math.hypot(check[0] - at[0], check[1] - at[1], check[2] - at[2]));
      changed++;
    }
  }
  return { changed, moved };
}

/**
 * Which side of the line from hip to ankle the studio bends a knee to, as the angle in bendLeg turns (+1 or -1): front
 * elbows fold back and hind knees forward (animal_standard_rig_blender.py, solve_leg). A fixed side, not one measured
 * from a pose: where the studio's leg could not fold enough, its knee lies on that line and a measured side flips.
 */
const kneeSide = (leg) => (leg[0].startsWith('fore') ? 1 : -1);

/**
 * Bends a planted leg again so its ankle lands on `target` after the body above it moved. The studio bends legs about
 * X only, so this works in the leg's Y–Z plane: hip, knee and ankle keep their sideways offsets and the bones their
 * lengths, the knee stays on `side` of the line from hip to ankle (where the studio bent it), and the paw keeps its
 * turn in the world (level, as it was planted).
 */
function bendLeg(locals, world, joints, [upperName, lowerName, pawName], target) {
  const side = kneeSide([upperName]);
  const [upper, lower, paw] = [joints[upperName], joints[lowerName], joints[pawName]];
  const [hip, knee, ankle] = [upper, lower, paw].map((joint) => positionOf(world, joint));
  const across = (from, to) => [to[1] - from[1], to[2] - from[2]];
  /** Turning about +X raises this angle of a (y, z) direction. */
  const angle = ([y, z]) => Math.atan2(z, y);
  const thigh = across(hip, knee);
  const shin = across(knee, ankle);
  const reach = across(hip, target);
  const [a, b] = [Math.hypot(...thigh), Math.hypot(...shin)];
  const d = Math.min(Math.max(Math.hypot(...reach), Math.abs(a - b) + 1e-6), a + b - 1e-6);
  const thighAngle = angle(reach) + side * Math.acos(Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d))));
  const kneeAt = [hip[1] + a * Math.cos(thighAngle), hip[2] + a * Math.sin(thighAngle)];
  const turnUpper = wrap(thighAngle - angle(thigh));
  const turnLower = wrap(angle([target[1] - kneeAt[0], target[2] - kneeAt[1]]) - angle(shin) - turnUpper);
  const parentFrame = worldRotation(locals, upper.getParentNode());
  const upperFrame = qmul(parentFrame, locals.get(upper).rotation);
  const lowerFrame = qmul(upperFrame, locals.get(lower).rotation);
  locals.get(upper).rotation = qmul(within(parentFrame, aboutX(turnUpper)), locals.get(upper).rotation);
  locals.get(lower).rotation = qmul(within(upperFrame, aboutX(turnLower)), locals.get(lower).rotation);
  locals.get(paw).rotation = qmul(within(lowerFrame, aboutX(-(turnUpper + turnLower))), locals.get(paw).rotation);
}

/**
 * A pose's planted paws (an ankle at most PLANTED above its height in idle, or lower; with `grounded` every paw, as the
 * studio's sit and lie mean them, where a straight leg left one short of the ground) and `posed(lift, moves, tilt)`:
 * the body raised by `lift` and tilted nose-down by `tilt`, each planted paw put back on the ground under where it
 * stood, moved by moves[region] = [along, up], and each paw in the air kept where it was, by bending the legs again.
 * With `still`, every paw stays exactly where it is.
 */
function planting(document, rig, locals, from = locals, still = false, grounded = false) {
  const { joints, ankles } = rig;
  const world = worldOf(document, locals);
  // Which paws stand, and where, comes from `from`: the studio's pose when `locals` is a changed one.
  const stood = from === locals ? world : worldOf(document, from);
  const pelvis = joints.pelvis;
  const up = invert3(world.get(pelvis.getParentNode()));
  const isPlanted = (leg) => !still && (grounded || positionOf(stood, joints[leg[2]])[1] <= ankles[leg[2]] + PLANTED);
  const planted = LEGS.filter(isPlanted).map((leg) => {
    const [x, , z] = positionOf(stood, joints[leg[2]]);
    return { leg, region: leg[0].replace('_upper', ''), limb: leg[0].split('_')[0], target: [x, ankles[leg[2]], z] };
  });
  // A paw in the air stays where it was in the air, whatever the body does.
  const lifted = LEGS.filter((leg) => !isPlanted(leg)).map((leg) => ({ leg, target: positionOf(stood, joints[leg[2]]) }));
  const posed = (lift, moves = {}, tilt = 0) => {
    const trial = new Map([...locals].map(([node, value]) => [node, { ...value }]));
    const offset = up([0, lift, 0]);
    trial.get(pelvis).translation = locals.get(pelvis).translation.map((value, i) => value + offset[i]);
    if (tilt) {
      // The body turns nose-down (tilt > 0) about the pelvis; the head keeps its turn in the world.
      const headFrame = worldRotation(trial, joints.head.getParentNode());
      const pelvisFrame = worldRotation(trial, pelvis.getParentNode());
      trial.get(pelvis).rotation = qmul(within(pelvisFrame, aboutX(tilt)), trial.get(pelvis).rotation);
      trial.get(joints.head).rotation = qmul(within(headFrame, aboutX(-tilt)), trial.get(joints.head).rotation);
    }
    const raised = worldOf(document, trial);
    for (const { leg, region, target } of planted) {
      const [along, rise] = moves[region] ?? [0, 0];
      bendLeg(trial, raised, joints, leg, [target[0], target[1] + rise, target[2] + along]);
    }
    for (const { leg, target } of lifted) bendLeg(trial, raised, joints, leg, target);
    return { locals: trial, world: worldOf(document, trial) };
  };
  /** How far each planted ankle ended from where it was put (a leg too short to reach). */
  const missed = (pose, moves = {}) =>
    planted.map(({ leg, region, target }) => {
      const [along, rise] = moves[region] ?? [0, 0];
      const [x, y, z] = positionOf(pose.world, joints[leg[2]]);
      return { region, distance: Math.hypot(x - target[0], y - target[1] - rise, z - target[2] - along), above: y - target[1] - rise };
    });
  return { world, planted, posed, missed };
}

/**
 * The least change that puts a pose of `clip` above AIM, or null when it is there already:
 *  1. the pelvis rises until the torso (body, head, tail) clears, the planted paws put back on the ground;
 *  2. each pair of legs (front, hind) still in the ground moves both paws together along the ground in the clip's
 *     direction (REPLANT) by the least that folds the legs out of it, every paw on the ground: the body may tilt
 *     (TILTS) for a pair to reach it; only when no tilt does are the paws raised, by at most the last of RAISES;
 *  3. only when no such move exists does the body rise further, LIFT.step at a time.
 */
function clearance(document, rig, locals, clip) {
  const { skinning } = rig;
  const plant = planting(document, rig, locals, locals, false, true);
  if (skinning.box(plant.world).min[1] >= AIM) return null;
  const replant = REPLANT[clip];
  let lift = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const torso = skinning.lowest(plant.posed(lift).world, 'torso');
    if (torso >= AIM) break;
    lift += AIM - torso + 0.0005;
  }
  for (let extra = 0; extra <= LIFT.max + 1e-9; extra += LIFT.step) {
    // Of the tilts that work, the first (TILTS' order) that raises the fewest paws off the ground.
    let best = null;
    for (const tilt of TILTS) {
      const moves = {};
      const solved = ['fore', 'hind'].every((limb) => {
        const pair = plant.planted.filter((entry) => entry.limb === limb);
        const direction = replant[limb];
        for (const rise of RAISES) {
          for (let step = 0; step * SLIDE.step <= (direction ? SLIDE.max : 0) + 1e-9; step++) {
            for (const { region } of pair) moves[region] = [direction * step * SLIDE.step, rise];
            const pose = plant.posed(lift + extra, moves, tilt);
            // A moved paw must land where it is put: on the ground, not in the air in front of a leg too short to reach.
            if (plant.missed(pose, moves).some((miss) => pair.some((entry) => entry.region === miss.region) && miss.distance > 0.002)) continue;
            if (pair.every(({ region }) => skinning.lowest(pose.world, region) >= AIM)) return true;
          }
        }
        return false;
      });
      if (!solved || skinning.box(plant.posed(lift + extra, moves, tilt).world).min[1] < AIM) continue;
      const raised = Object.values(moves).reduce((sum, [, rise]) => sum + rise, 0);
      if (!best || raised < best.raised - 1e-9) best = { lift: lift + extra, moves, tilt, raised };
      if (raised === 0) break;
    }
    if (best) return { lift: best.lift, moves: best.moves, tilt: best.tilt };
  }
  throw new Error(`${clip}: no pose clears the ground (lowest point ${skinning.box(plant.world).min[1]} m)`);
}

/** The lift that, on top of `lift`, puts `plant.posed(lift, moves)` above AIM. */
function extraLift(rig, plant, lift, moves, tilt = 0) {
  let extra = 0;
  for (let attempt = 0; attempt < 40; attempt++) {
    const lowest = rig.skinning.box(plant.posed(lift + extra, moves, tilt).world).min[1];
    if (lowest >= AIM) return extra;
    extra += AIM - lowest + 0.0005;
  }
  throw new Error(`no lift clears the ground (lowest point after ${extra} m of lift)`);
}

/** The smallest values at least `values` that change by at most `rate` from one to the next. */
const envelope = (values, rate) => values.map((_, i) => Math.max(...values.map((value, j) => value - rate * Math.abs(i - j))));

/**
 * New LINEAR keys at `times`, taken from `poses`, for what grounding moves: the pelvis, the posture joints and the
 * legs. A joint the clip never keyed and that stays at rest gets no channel.
 */
function rekey(document, rig, animation, times, poses) {
  const buffer = document.getRoot().listBuffers()[0];
  const input = document.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buffer);
  const targets = [[rig.joints.pelvis, 'translation'], ...[...POSTURE, ...LEGS.flat()].map((name) => [rig.joints[name], 'rotation'])];
  for (const [node, path] of targets) {
    const values = poses.map((locals) => [...locals.get(node)[path]]);
    const keyed = animation.listChannels().some((candidate) => candidate.getTargetNode() === node && candidate.getTargetPath() === path);
    const rest = path === 'rotation' ? node.getRotation() : node.getTranslation();
    if (!keyed && values.every((value) => value.every((component, i) => Math.abs(component - rest[i]) < 1e-7))) continue;
    // Neighbouring keys on the same side of the quaternion sphere, so every step turns the short way.
    if (path === 'rotation') {
      for (let i = 1; i < values.length; i++) {
        if (values[i].reduce((sum, value, k) => sum + value * values[i - 1][k], 0) < 0) values[i] = values[i].map((value) => -value);
      }
    }
    const output = document.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(values.flat())).setBuffer(buffer);
    const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
    animation.addSampler(sampler);
    const channel = animation.listChannels().find((candidate) => candidate.getTargetNode() === node && candidate.getTargetPath() === path);
    if (!channel) {
      animation.addChannel(document.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
      continue;
    }
    const old = channel.getSampler();
    channel.setSampler(sampler);
    if (!old.listParents().some((parent) => parent.propertyType === 'AnimationChannel')) old.dispose();
  }
}

/**
 * The body and legs `share` of the way from `locals` to `standing` (the clip's first frame); tail and ears keep their
 * motion. Legs are blended, not bent again: a leg whose lower bone the studio cut short (0.8 cm, where its leg
 * finder met fur early) has no stable bend to solve for, and the blend keeps planted paws where both poses put them.
 */
function towards(locals, standing, joints, share) {
  const blended = new Map([...locals].map(([node, value]) => [node, { ...value }]));
  for (const name of [...POSTURE, ...LEGS.flat()]) {
    const node = joints[name];
    const [from, to] = [locals.get(node), standing.get(node)];
    blended.get(node).rotation = slerp(from.rotation, to.rotation, share);
    blended.get(node).translation = from.translation.map((value, i) => value + (to.translation[i] - value) * share);
  }
  return blended;
}

/**
 * Where a paw is at `phase` (0–1) of its cycle, from the middle of its step, as [forward, up]: on the ground for `duty`
 * of the cycle moving back at one speed, then forward through the air over an arc `lift` high.
 */
function pawPath(phase, duty, stride, lift) {
  if (phase < duty) return [stride / 2 - (stride * phase) / duty, 0];
  const s = (phase - duty) / (1 - duty);
  return [-stride / 2 + stride * s * s * (3 - 2 * s), lift * Math.sin(Math.PI * s)];
}

/** The hip-ankle distance of a leg with bones a and b and the angle `angle` at the knee. */
const legLength = (a, b, angle) => Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(angle));

/**
 * Makes `name` (walk or run) again as GAITS[name] says, keyed STEP.keys times a cycle. Each paw steps along the ground
 * under where it stands in idle, the paws on the ground all moving back at stride / (duty * seconds). The legs reach
 * their paws by bending (bendLeg) within STEP.bend of how they stand; the fore hips and the hind hips each take the
 * smoothest height that lets their legs reach (a corridor per key, relaxed towards a straight line and towards the
 * studio's height), which raises, lowers and pitches the body, the head kept level. A paw steps lower than `lift` where
 * its knee cannot fold enough for the corridor to stay open. A leg whose skin goes into the ground at some key steps
 * around a point a little before or behind where it stands. The longest stride, from `angle` either side of the hip
 * down, for which all this works is kept. The studio's spine flex goes (the body's pitch does its work); its head, ear
 * and tail motion stays, played at the new pace.
 */
function gait(document, rig, name) {
  const g = GAITS[name];
  const animation = clipOf(document, name);
  const studio = durationOf(animation);
  const { pelvis, head, spine_1: spine } = rig.joints;
  const n = STEP.keys;
  const us = Array.from({ length: n + 1 }, (_, i) => i / n);
  const legs = LEGS.map((leg) => {
    const key = leg[0].replace('_upper', '');
    const [hip, knee, ankle] = leg.map((joint) => positionOf(rig.standing, rig.joints[joint]));
    const across = (from, to) => Math.hypot(to[1] - from[1], to[2] - from[2]);
    const [a, b, d] = [across(hip, knee), across(knee, ankle), across(hip, ankle)];
    const rest = Math.acos(Math.min(1, Math.max(-1, (a * a + b * b - d * d) / (2 * a * b))));
    const bend = (STEP.bend * Math.PI) / 180;
    return {
      leg,
      key,
      group: key.startsWith('fore') ? 0 : 1,
      phase: g.phases[key],
      ankle,
      lo: legLength(a, b, Math.max(0.05, rest - bend)),
      hi: Math.min(STEP.straight * (a + b), legLength(a, b, Math.min(Math.PI, rest + bend))),
      height: hip[1] - ankle[1],
    };
  });
  const reach = Math.min(...legs.map((l) => l.height));
  const up = invert3(rig.standing.get(pelvis.getParentNode()));
  const seat = pelvis.getTranslation();
  /** The studio's pose at key i, its spine straight, with the body raised by `rise` and pitched by `pitch` (radians,
   *  about X at the pelvis) and the head turned back by the pitch. */
  const bodyAt = (i, rise = 0, pitch = 0) => {
    const locals = localsAt(document, animation, us[i] * studio);
    locals.get(spine).rotation = spine.getRotation();
    const shift = up([0, rise, 0]);
    locals.get(pelvis).translation = seat.map((value, k) => value + shift[k]);
    if (pitch) {
      const headFrame = worldRotation(locals, head.getParentNode());
      const pelvisFrame = worldRotation(locals, pelvis.getParentNode());
      locals.get(pelvis).rotation = qmul(within(pelvisFrame, aboutX(pitch)), locals.get(pelvis).rotation);
      locals.get(head).rotation = qmul(within(headFrame, aboutX(-pitch)), locals.get(head).rotation);
    }
    return locals;
  };
  const bases = us.map((_, i) => worldOf(document, bodyAt(i)));
  const hips = bases.map((world) => legs.map((l) => positionOf(world, rig.joints[l.leg[0]])));
  const pivots = bases.map((world) => positionOf(world, pelvis));
  // How far ahead of the pelvis the fore and the hind hips are, per key.
  const ahead = us.map((_, i) => [0, 1].map((group) => {
    const own = legs.flatMap((l, k) => (l.group === group ? [hips[i][k][2] - pivots[i][2]] : []));
    return own.reduce((sum, z) => sum + z, 0) / own.length;
  }));
  /** The rise and pitch that lift the fore hips by `fore` and the hind hips by `hind`. */
  const bodyFor = (i, fore, hind) => {
    const [zf, zh] = ahead[i];
    const s = Math.max(-0.5, Math.min(0.5, (hind - fore) / (zf - zh)));
    return [hind + zh * s, Math.asin(s)];
  };
  const standsAt = (l, u) => (u + l.phase) % 1 < g.duty;
  const targetOf = (l, u, stride, centre, lift) => {
    const [along, rise] = pawPath((u + l.phase) % 1, g.duty, stride, lift);
    return [l.ankle[0], rig.ankles[l.leg[2]] + rise, centre + along];
  };
  /** Per key, for the fore and the hind hips, the heights (over the studio's) at which their legs reach: [low, high]. */
  const corridor = (stride, centres, lifts) => us.map((u, i) => [0, 1].map((group) => {
    let [low, high] = [-Infinity, Infinity];
    legs.forEach((l, k) => {
      if (l.group !== group) return;
      const t = targetOf(l, u, stride, centres[k], lifts[k]);
      const [over, dz] = [hips[i][k][1] - t[1], hips[i][k][2] - t[2]];
      const [lo, hi] = [l.lo + 0.0005, l.hi - 0.0005];
      // A paw on the ground must be reached; one in the air may fall a little short (it is in the air).
      if (standsAt(l, u)) high = Math.min(high, hi * hi < dz * dz ? -Infinity : Math.sqrt(hi * hi - dz * dz) - over);
      if (lo * lo > dz * dz) low = Math.max(low, Math.sqrt(lo * lo - dz * dz) - over);
    });
    return [low, high];
  }));
  const open = (bounds) => bounds.every((pair) => pair.every(([low, high]) => low <= high));
  /** The smoothest periodic heights within the corridor, near the studio's where it is free, pitching at most STEP.pitch. */
  const ride = (bounds) => {
    const clamp = (value, i, group) => Math.min(bounds[i][group][1], Math.max(bounds[i][group][0], value));
    let lanes = [0, 1].map((group) => us.slice(0, n).map((_, i) => clamp(0, i, group)));
    for (let pass = 0; pass < 300; pass++) {
      lanes = lanes.map((h, group) => h.map((value, i) => clamp(0.995 * (0.25 * h[(i + n - 1) % n] + 0.5 * value + 0.25 * h[(i + 1) % n]), i, group)));
      for (let i = 0; i < n; i++) {
        const most = (ahead[i][0] - ahead[i][1]) * Math.sin(STEP.pitch);
        const gap = lanes[1][i] - lanes[0][i];
        if (Math.abs(gap) <= most) continue;
        const half = ((Math.abs(gap) - most) / 2) * Math.sign(gap);
        lanes[0][i] = clamp(lanes[0][i] + half, i, 0);
        lanes[1][i] = clamp(lanes[1][i] - half, i, 1);
      }
    }
    return us.map((_, i) => bodyFor(i, lanes[0][i % n], lanes[1][i % n]));
  };
  const legWorld = (body, l, target) => {
    const trial = new Map([...body.locals].map(([node, value]) => [node, { ...value }]));
    bendLeg(trial, body.world, rig.joints, l.leg, target);
    return worldOf(document, trial);
  };
  const shifts = [0];
  for (let step = 1; step <= 15; step++) shifts.push(-step * 0.002, step * 0.002);
  const longest = 2 * reach * Math.tan((g.angle * Math.PI) / 180);
  let found;
  for (let stride = longest; stride > 0.15 * longest && !found; stride *= 0.95) {
    const centres = legs.map((l) => l.ankle[2]);
    let lifts = legs.map(() => g.lift * reach);
    let failed = false;
    for (let round = 0; round < 3 && !failed; round++) {
      // Steps as high as the knees fold for, a leg at a time from the lowest.
      if (!open(corridor(stride, centres, lifts))) {
        lifts = legs.map(() => STEP.least * reach);
        if (!open(corridor(stride, centres, lifts))) {
          failed = true;
          break;
        }
        for (const k of legs.keys()) {
          const fits = (lift) => open(corridor(stride, centres, lifts.map((value, j) => (j === k ? lift : value))));
          let [low, high] = [lifts[k], g.lift * reach];
          if (fits(high)) low = high;
          else for (let step = 0; step < 10; step++) [low, high] = fits((low + high) / 2) ? [(low + high) / 2, high] : [low, (low + high) / 2];
          lifts[k] = low;
        }
      }
      const bodies = ride(corridor(stride, centres, lifts));
      const list = us.map((_, i) => {
        const locals = bodyAt(i, ...bodies[i]);
        return { locals, world: worldOf(document, locals) };
      });
      // A leg whose skin goes into the ground steps around a point a little before or behind.
      let moved = false;
      for (const [k, l] of legs.entries()) {
        const clears = (centre) => us.every((u, i) => rig.skinning.lowest(legWorld(list[i], l, targetOf(l, u, stride, centre, lifts[k])), l.key) >= FLOOR);
        if (clears(centres[k])) continue;
        const next = shifts.map((shift) => l.ankle[2] + shift).find((centre) => {
          const bounds = corridor(stride, centres.map((value, j) => (j === k ? centre : value)), lifts);
          return bounds.every((pair) => pair[l.group][0] <= pair[l.group][1]) && clears(centre);
        });
        if (next === undefined) {
          failed = true;
          break;
        }
        centres[k] = next;
        moved = true;
      }
      if (!moved) break;
    }
    if (failed) continue;
    const bounds = corridor(stride, centres, lifts);
    if (!open(bounds)) continue;
    const bodies = ride(bounds);
    const poses = us.map((u, i) => {
      const locals = bodyAt(i, ...bodies[i]);
      const world = worldOf(document, locals);
      const targets = legs.map((l, k) => targetOf(l, u, stride, centres[k], lifts[k]));
      legs.forEach((l, k) => bendLeg(locals, world, rig.joints, l.leg, targets[k]));
      return { locals, targets, world: worldOf(document, locals) };
    });
    // Paws on the ground where they were put, nothing in the ground, the pitch near its limit.
    const missed = Math.max(...poses.flatMap((pose, i) => legs.flatMap((l, k) => {
      if (!standsAt(l, us[i])) return [];
      return [Math.hypot(...positionOf(pose.world, rig.joints[l.leg[2]]).map((value, axis) => value - pose.targets[k][axis]))];
    })));
    const lowest = Math.min(...poses.map((pose) => rig.skinning.box(pose.world).min[1]));
    const pitch = Math.max(...bodies.map(([, angle]) => Math.abs(angle)));
    const heads = poses.map((pose) => positionOf(pose.world, head)[1]);
    if (missed > 0.001 || lowest < FLOOR || pitch > 1.25 * STEP.pitch || Math.max(...heads) - Math.min(...heads) > STEP.bob) continue;
    found = { stride, centres, lifts, bodies, poses, lowest, bob: Math.max(...heads) - Math.min(...heads) };
  }
  if (!found) throw new Error(`${name}: no stride the legs reach`);
  // Every channel the clip had, and the pelvis, head and legs, keyed again on the new cycle.
  const buffer = document.getRoot().listBuffers()[0];
  const input = document.createAccessor().setType('SCALAR').setArray(new Float32Array(us.map((u) => u * g.seconds))).setBuffer(buffer);
  const targets = new Map();
  const target = (node, path) => {
    if (!targets.has(node)) targets.set(node, new Set());
    targets.get(node).add(path);
  };
  for (const channel of animation.listChannels()) target(channel.getTargetNode(), channel.getTargetPath());
  for (const node of [pelvis, head, spine, ...LEGS.flat().map((joint) => rig.joints[joint])]) target(node, 'rotation');
  target(pelvis, 'translation');
  for (const [node, paths] of targets) {
    for (const path of paths) {
      const values = found.poses.map((pose) => [...pose.locals.get(node)[path]]);
      const still = path === 'rotation' ? node.getRotation() : path === 'translation' ? node.getTranslation() : node.getScale();
      const keyed = animation.listChannels().find((channel) => channel.getTargetNode() === node && channel.getTargetPath() === path);
      if (!keyed && values.every((value) => value.every((component, i) => Math.abs(component - still[i]) < 1e-7))) continue;
      if (path === 'rotation') {
        for (let i = 1; i < values.length; i++) {
          if (values[i].reduce((sum, value, k) => sum + value * values[i - 1][k], 0) < 0) values[i] = values[i].map((value) => -value);
        }
      }
      const output = document.createAccessor().setType(path === 'rotation' ? 'VEC4' : 'VEC3').setArray(new Float32Array(values.flat())).setBuffer(buffer);
      const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
      animation.addSampler(sampler);
      if (!keyed) {
        animation.addChannel(document.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
        continue;
      }
      const old = keyed.getSampler();
      keyed.setSampler(sampler);
      if (!old.listParents().some((parent) => parent.propertyType === 'AnimationChannel')) old.dispose();
    }
  }
  return {
    stride: found.stride,
    speed: found.stride / (g.duty * g.seconds),
    lowest: found.lowest,
    lifts: found.lifts,
    shifts: found.centres.map((centre, k) => centre - legs[k].ankle[2]),
    rise: [Math.min(...found.bodies.map(([rise]) => rise)), Math.max(...found.bodies.map(([rise]) => rise))],
    pitch: Math.max(...found.bodies.map(([, angle]) => Math.abs(angle))),
    bob: found.bob,
  };
}

/**
 * Puts the clip `name` above the ground, keyed at KEYS a second; a clip that clears FLOOR keeps its keys.
 * Sitting and lying take one correction (`clearance`), found at the deepest frame and applied in proportion to how far
 * each frame has lowered the pelvis, so the paws slide and the body settles together with the studio's motion; frames
 * still below AIM rise a little more, the lift smoothed to at most LIFT.rate a key. A jump instead crouches less: each
 * frame's body and legs move the least share of the way back to the clip's first, standing frame that clears the
 * ground (see `towards`), smoothed to at most SHARE_RATE a key; a frame that still dips standing up (paws the studio
 * slid forward) rises a little. A sit or lie that no re-planting can clear crouches less the same way.
 * Returns the clip's lowest point before and after, the most the body rose, the paws slid and rose, a planted paw ended
 * above the ground and the pose went back towards standing, and how much of its depth the deepest frame `kept`.
 */
function ground(document, rig, name) {
  const animation = clipOf(document, name);
  const keys = Math.round(durationOf(animation) * KEYS);
  const times = Array.from({ length: keys + 1 }, (_, key) => key / KEYS);
  const originals = times.map((t) => localsAt(document, animation, t));
  const lowest = (world) => rig.skinning.box(world).min[1];
  const before = Math.min(...originals.map((locals) => lowest(worldOf(document, locals))));
  const stats = { before, after: before, lift: 0, slide: 0, raise: 0, float: 0, upright: 0, kept: 1 };
  if (before >= FLOOR) return stats;
  let poses;
  if (REPLANT[name].fore || REPLANT[name].hind) {
    const plants = originals.map((locals) => planting(document, rig, locals, locals, false, true));
    const heights = plants.map((plant) => positionOf(plant.world, rig.joints.pelvis)[1]);
    const depths = heights.map((height) => heights[0] - height);
    const deepest = depths.indexOf(Math.max(...depths));
    let hold;
    try {
      hold = clearance(document, rig, originals[deepest], name) ?? { lift: 0, moves: {}, tilt: 0 };
    } catch (error) {
      // No re-planting keeps these legs out of the ground (a leg that cannot fold): this clip crouches less instead.
      if (!String(error.message).includes('no pose clears')) throw error;
      stats.fallback = true;
    }
    if (hold) {
      const plan = depths.map((depth) => {
        const share = Math.min(1, Math.max(0, depth / depths[deepest]));
        return { lift: hold.lift * share, tilt: hold.tilt * share, moves: Object.fromEntries(Object.entries(hold.moves).map(([region, move]) => [region, move.map((value) => value * share)])) };
      });
      const lifts = envelope(
        plan.map(({ lift, moves, tilt }, key) => lift + extraLift(rig, plants[key], lift, moves, tilt)),
        LIFT.rate,
      );
      poses = plants.map((plant, key) => {
        const { moves, tilt } = plan[key];
        if (lifts[key] === 0 && !tilt && !Object.values(moves).some((move) => move.some(Boolean))) return { locals: originals[key], world: plant.world, misses: [] };
        const pose = plant.posed(lifts[key], moves, tilt);
        return { ...pose, misses: plant.missed(pose, moves) };
      });
      const moved = plan.flatMap(({ moves }) => Object.values(moves));
      stats.lift = Math.max(...lifts);
      stats.tilt = hold.tilt;
      stats.kept = 1 - lifts[deepest] / depths[deepest];
      stats.slide = Math.max(0, ...moved.map(([along]) => Math.abs(along)));
      stats.raise = Math.max(0, ...moved.map(([, rise]) => rise));
      // Lifted almost back to standing, the re-planted legs only reach the ground stretched: crouch less instead.
      if (stats.kept < KEPT) {
        poses = undefined;
        Object.assign(stats, { lift: 0, tilt: 0, slide: 0, raise: 0, fallback: true });
      }
    }
  }
  if (!poses) {
    const standing = originals[0];
    const up = invert3(worldOf(document, standing).get(rig.joints.pelvis.getParentNode()));
    const upright = (locals, share, lift = 0) => {
      const pose = towards(locals, standing, rig.joints, share);
      if (lift) {
        const offset = up([0, lift, 0]);
        pose.get(rig.joints.pelvis).translation = pose.get(rig.joints.pelvis).translation.map((value, i) => value + offset[i]);
      }
      return { locals: pose, world: worldOf(document, pose) };
    };
    // The least share of the way back to standing that clears; a frame that standing does not clear rises a little too.
    const needed = originals.map((locals) => {
      if (lowest(worldOf(document, locals)) >= AIM) return { share: 0, lift: 0 };
      let lift = 0;
      for (let attempt = 0; attempt < 40 && lowest(upright(locals, 1, lift).world) < AIM; attempt++) lift += AIM - lowest(upright(locals, 1, lift).world) + 0.0005;
      if (lift > 0) return { share: 1, lift };
      let [low, high] = [0, 1];
      for (let step = 0; step < 12; step++) {
        const middle = (low + high) / 2;
        if (lowest(upright(locals, middle).world) >= AIM) high = middle;
        else low = middle;
      }
      return { share: high, lift: 0 };
    });
    const shares = envelope(needed.map(({ share }) => share), SHARE_RATE);
    const lifts = envelope(needed.map(({ lift }) => lift), LIFT.rate);
    poses = originals.map((locals, key) => {
      if (shares[key] === 0 && lifts[key] === 0) return { locals, world: worldOf(document, locals), misses: [] };
      // How far each paw that stood on the ground in the studio's frame ends above where it stood.
      const before = worldOf(document, locals);
      const pose = upright(locals, shares[key], lifts[key]);
      const misses = PAWS.filter((paw) => positionOf(before, rig.joints[paw])[1] <= rig.ankles[paw] + PLANTED).map((paw) => ({
        above: positionOf(pose.world, rig.joints[paw])[1] - Math.max(rig.ankles[paw], positionOf(before, rig.joints[paw])[1]),
      }));
      return { ...pose, misses };
    });
    stats.lift = Math.max(...lifts);
    stats.upright = Math.max(...shares);
    stats.kept = 1 - stats.upright;
  }
  rekey(document, rig, animation, times, poses.map((pose) => pose.locals));
  stats.after = Math.min(...poses.map((pose) => lowest(pose.world)));
  stats.float = Math.max(0, ...poses.flatMap((pose) => pose.misses.map((miss) => miss.above)));
  return stats;
}

/** Adds `hold.name`: `hold.from` (already grounded) at `hold.at` s, held for `hold.seconds` (two equal keys, so it loops). */
function addHold(document, rig, hold) {
  const source = clipOf(document, hold.from);
  const locals = localsAt(document, source, hold.at);
  // The grounded clip clears the ground on its keys; between them (1.1 s) it may need a touch more.
  const plant = planting(document, rig, locals, locals, true);
  const lift = rig.skinning.box(plant.world).min[1] >= AIM ? 0 : extraLift(rig, plant, 0, {});
  const pose = lift ? plant.posed(lift).locals : locals;
  const buffer = document.getRoot().listBuffers()[0];
  const animation = document.createAnimation(hold.name);
  const times = document.createAccessor(`${hold.name}-time`).setType('SCALAR').setArray(new Float32Array([0, hold.seconds])).setBuffer(buffer);
  for (const channel of source.listChannels()) {
    const value = pose.get(channel.getTargetNode())[channel.getTargetPath()];
    const output = document
      .createAccessor()
      .setType(value.length === 4 ? 'VEC4' : 'VEC3')
      .setArray(new Float32Array([...value, ...value]))
      .setBuffer(buffer);
    const sampler = document.createAnimationSampler().setInput(times).setOutput(output).setInterpolation('LINEAR');
    animation.addSampler(sampler).addChannel(
      document.createAnimationChannel().setTargetNode(channel.getTargetNode()).setTargetPath(channel.getTargetPath()).setSampler(sampler),
    );
  }
}

async function writePicture(image, output) {
  const fitted = await sharp(image).trim().resize(PICTURE.fit, PICTURE.fit, { fit: 'inside' }).toBuffer({ resolveWithObject: true });
  const { width, height } = fitted.info;
  const left = Math.floor((PICTURE.size - width) / 2);
  const top = Math.floor((PICTURE.size - height) / 2);
  await sharp(fitted.data)
    .ensureAlpha()
    .extend({ left, top, right: PICTURE.size - width - left, bottom: PICTURE.size - height - top, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp(PICTURE.webp)
    .toFile(output);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const round = (value, digits = 3) => Number(value.toFixed(digits));

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
const io = new NodeIO()
  .setLogger(new Logger(Logger.Verbosity.WARN))
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

/** One dog: the breed entry, or a string saying why it was skipped. */
async function normalize(folder, id) {
  const record = JSON.parse(readFileSync(join(folder, id, 'record.json'), 'utf8'));
  const name = record.name;
  if (EXCLUDED[id]) return `${id}: excluded (${EXCLUDED[id]})`;
  if (record.species !== 'dog') return `${id} ${name}: species ${record.species}`;
  if (record.stages?.standard?.status !== 'complete') return `${id} ${name}: standard stage not complete`;
  const slug = SLUGS[name];
  if (!slug) throw new Error(`${id}: no slug for ${name}; add it to SLUGS`);
  const bytes = readFileSync(join(folder, id, 'motions-standard.glb'));
  if (sha256(bytes) !== record.files?.['motions-standard.glb']) return `${id} ${name}: motions-standard.glb is not the file the record names`;
  const picture = join(folder, id, 'front.png');
  if (!existsSync(picture)) return `${id} ${name}: no front.png`;

  const document = await io.readBinary(bytes);
  const { joints, problem } = check(document);
  if (problem) return `${id} ${name}: ${problem}`;
  const idle = pose(document, clipOf(document, 'idle'), 0);
  if (!facesForward(idle, joints)) return `${id} ${name}: does not face +Z`;

  // Stand it on the origin at HEIGHT, centred between its paws, through a parent of everything in the scene.
  const box = skinningOf(document).box(idle);
  const paws = PAWS.map((paw) => positionOf(idle, joints[paw]));
  const centre = [0, 2].map((axis) => paws.reduce((sum, paw) => sum + paw[axis], 0) / paws.length);
  const scale = HEIGHT / box.size[1];
  const scene = sceneOf(document);
  const fit = document.createNode(slug);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    fit.addChild(child);
  }
  scene.addChild(fit);
  fit.setScale([scale, scale, scale]).setTranslation([-centre[0] * scale, -box.min[1] * scale, -centre[1] * scale]);

  const dropped = dropStillChannels(document);
  // The studio's lowest point in each clip and pace of its walk and run, for the log.
  const studioSkin = skinningOf(document);
  const studio = Object.fromEntries(Object.keys(CLIPS).map((clip) => [clip, lowestOf(document, studioSkin, clipOf(document, clip))]));
  for (const hold of HOLDS) studio[hold.name] = studioSkin.box(pose(document, clipOf(document, hold.from), hold.at)).min[1];
  const paces = Object.fromEntries(Object.keys(GAITS).map((clip) => [clip, strideSpeed(document, joints, clip)]));
  // Soles onto the paws, walk and run again, what sinks into the ground lifted, then the still loops cut.
  const soles = plantSoles(document, joints);
  if (soles.moved > 1e-6) throw new Error(`${slug}: binding the soles moved idle by ${soles.moved} m`);
  const standing = pose(document, clipOf(document, 'idle'), 0);
  const rig = { skinning: skinningOf(document), joints, standing, ankles: Object.fromEntries(PAWS.map((paw) => [paw, positionOf(standing, joints[paw])[1]])) };
  const gaits = Object.fromEntries(Object.keys(GAITS).map((clip) => [clip, gait(document, rig, clip)]));
  const grounded = Object.fromEntries(HOLDS.map((hold) => [hold.name, { before: studio[hold.name] }]));
  for (const clip of GROUNDED) grounded[clip] = ground(document, rig, clip);
  // These dogs stay listed (the server seeds its breeds from breeds.json); the log says which poses lost their depth.
  const lost = ['sit', 'lie'].filter((clip) => grounded[clip].kept < KEPT);
  const shins = LEGS.map(([, lower, paw]) => {
    const [knee, ankle] = [positionOf(standing, joints[lower]), positionOf(standing, joints[paw])];
    return Math.hypot(ankle[1] - knee[1], ankle[2] - knee[2]);
  });
  for (const hold of HOLDS) addHold(document, rig, hold);
  for (const material of document.getRoot().listMaterials()) {
    material.setMetallicFactor(0).setRoughnessFactor(1).setMetallicRoughnessTexture(null);
  }
  await document.transform(
    dedup(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', ...COLOR_MAP }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', ...NORMAL_MAP }),
    meshopt({ encoder: MeshoptEncoder }),
  );
  const glb = await io.writeBinary(document);

  // Read the written file back and check what the app will load.
  const written = await io.readBinary(glb);
  const again = check(written, { ...CLIPS, ...Object.fromEntries(Object.entries(GAITS).map(([clip, { seconds }]) => [clip, seconds])) });
  if (again.problem) throw new Error(`${slug}: written file: ${again.problem}`);
  const clips = Object.fromEntries(written.getRoot().listAnimations().map((animation) => [animation.getName(), round(durationOf(animation), 4)]));
  for (const hold of HOLDS) {
    if (clips[hold.name] !== hold.seconds) throw new Error(`${slug}: ${hold.name} lasts ${clips[hold.name]} s`);
  }
  const skinning = skinningOf(written);
  const stood = pose(written, clipOf(written, 'idle'), 0);
  const placed = skinning.box(stood);
  if (Math.abs(placed.size[1] - HEIGHT) > 0.005 || Math.abs(placed.min[1]) > 0.005 || !facesForward(stood, again.joints)) {
    throw new Error(`${slug}: written file stands ${placed.size[1]} m tall from ${placed.min[1]}`);
  }
  // The lowest point of every clip as written, on its keys and between them (a hold is one pose).
  const lowest = Object.fromEntries(written.getRoot().listAnimations().map((animation) => [animation.getName(), lowestOf(written, skinning, animation)]));
  for (const [clip, min] of Object.entries(lowest)) {
    if (min < FLOOR) throw new Error(`${slug}: written ${clip} goes ${min} m into the ground`);
  }

  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, `${slug}.glb`), glb);
  await writePicture(picture, join(modelDir, `${slug}.webp`));
  const triangles = written.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives()).reduce((sum, primitive) => sum + primitive.getIndices().getCount() / 3, 0);
  const entry = {
    slug,
    name,
    source: id,
    order: record.order ?? 0,
    model: `/gltf/pets/${slug}.glb`,
    thumbnail: `/gltf/pets/${slug}.webp`,
    sha256: sha256(glb),
    bytes: glb.byteLength,
    height_m: round(placed.size[1]),
    length_m: round(placed.size[2]),
    width_m: round(placed.size[0]),
    stride_mps: { walk: round(strideSpeed(written, again.joints, 'walk')), run: round(strideSpeed(written, again.joints, 'run')) },
    clips,
  };
  const cm = (metres, digits = 2) => (metres * 100).toFixed(digits);
  console.log(
    `${slug} ${name}: ${(glb.byteLength / 1024).toFixed(0)} KB (from ${(bytes.length / 1048576).toFixed(1)} MB), ${triangles} triangles, ` +
      `${entry.width_m} x ${entry.height_m} x ${entry.length_m} m, ${dropped} still channels dropped, ${soles.changed} sole vertices onto the paws`,
  );
  for (const [clip, made] of Object.entries(gaits)) {
    console.log(
      `  ${clip}: ${round(paces[clip])} -> ${entry.stride_mps[clip]} m/s (${GAITS[clip].seconds} s a cycle, steps ${cm(made.stride, 1)} cm long, ` +
        `${made.lifts.map((lift) => cm(lift, 1)).join('/')} cm high), body ${cm(made.rise[0], 1)}..${cm(made.rise[1], 1)} cm, ` +
        `pitch up to ${((made.pitch * 180) / Math.PI).toFixed(1)}°, head bob ${cm(made.bob, 1)} cm`,
    );
  }
  console.log(
    `  lowest point, cm (studio -> written): ${Object.entries(lowest)
      .map(([clip, min]) => {
        const lifted = grounded[clip];
        const was = `${clip} ${cm(studio[clip])} -> ${cm(min)}`;
        if (!lifted || lifted.lift === undefined || lifted.before >= FLOOR) return was;
        const moves = lifted.upright ? [`pose up to ${Math.round(lifted.upright * 100)}% back to standing`] : [];
        if (!lifted.upright || lifted.lift > 0.00005) moves.push(`body up to +${cm(lifted.lift)}`);
        if (lifted.tilt) moves.push(`tilted ${((lifted.tilt * 180) / Math.PI).toFixed(0)}° nose-${lifted.tilt > 0 ? 'down' : 'up'}`);
        if (lifted.slide) moves.push(`paws moved up to ${cm(lifted.slide)}`);
        if (lifted.raise) moves.push(`raised up to ${cm(lifted.raise)}`);
        if (lifted.float > 0.0005) moves.push(`lifted off up to ${cm(lifted.float)}`);
        return `${was} (${moves.join(', ')})`;
      })
      .join(', ')}`,
  );
  if (lost.length) {
    const kept = lost.map((clip) => `${clip} ${Math.round(Math.max(0, grounded[clip].kept) * 100)}%`).join(', ');
    console.warn(
      `  ${slug}: out of the ground its ${lost.join(' and ')} keep only ${kept} of their depth: lower leg bones ` +
        `${shins.map((shin) => (shin * 100).toFixed(1)).join('/')} cm cannot fold (re-rig the studio dog ${id} to fix)`,
    );
  }
  return entry;
}

const [folderArg, ...ids] = process.argv.slice(2);
if (!folderArg) throw new Error('usage: node scripts/pets-normalize.mjs <folder of studio animals> [ids...]');
const folder = resolve(folderArg);
const wanted = ids.length ? ids : readdirSync(folder).filter((entry) => /^[0-9a-f]{24}$/.test(entry) && existsSync(join(folder, entry, 'record.json')));
const breeds = new Map();
if (ids.length && existsSync(manifestPath)) {
  for (const entry of JSON.parse(readFileSync(manifestPath, 'utf8'))) breeds.set(entry.slug, entry);
}
for (const id of wanted) {
  const result = await normalize(folder, id);
  if (typeof result === 'string') {
    console.log(`skipped ${result}`);
    for (const [slug, entry] of breeds) if (entry.source === id) breeds.delete(slug);
  } else {
    breeds.set(result.slug, result);
  }
}
const list = [...breeds.values()].sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(list, null, 2)}\n`);
console.log(`${list.length} breeds, ${(list.reduce((sum, entry) => sum + entry.bytes, 0) / 1048576).toFixed(1)} MB of models -> ${manifestPath}`);
// Files of breeds the list no longer has are left for a person to delete.
const listed = new Set(list.flatMap((entry) => [`${entry.slug}.glb`, `${entry.slug}.webp`]));
const stray = existsSync(modelDir) ? readdirSync(modelDir).filter((file) => !listed.has(file)) : [];
if (stray.length) console.warn(`not in breeds.json: ${stray.map((file) => join(modelDir, file)).join(', ')}`);
