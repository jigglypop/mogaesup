// A stand-in for the character server (backend/) for scripts/character-e2e.mjs: a few characters from the studio, and
// just the answers the Rust server's gateway and catalog imports read and the studio screens show (the admins' asset
// library, photo, body and parts screens, the members' wardrobe). Every /api/ request must carry the operator token,
// API key and gateway key the Rust server signs with; anything unsigned, or a path it does not know, is noted in
// `problems`. Nothing here costs money.
// The models come from a figure gaesup-world ships, rewritten the way the character server delivers them: plain
// geometry and PNG maps, rigged, with idle, walk and run clips.
// Usage: node scripts/e2e/fake-character-server.mjs [port]   (prints the settings the Rust server needs; forked, it
// talks to its parent instead)
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dequantize, textureCompress, unpartition } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';

const FIGURE = resolve(dirname(fileURLToPath(import.meta.resolve('gaesup-world'))), '..', 'public/gltf/trainer_red.glb');
/** What the package's figures use and the character server's exports do not. */
const PACKAGE_ONLY = ['EXT_meshopt_compression', 'KHR_mesh_quantization', 'EXT_texture_webp'];
const ISSUER = 'mogaesup';
const AUDIENCE = 'mogaesup-client';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** A stable 24-hex id, the shape the character server gives jobs, versions and faces. */
const hex = (seed) => sha256(`e2e:${seed}`).slice(0, 24);

/**
 * The figure as the character server would deliver it, a re-sealed copy of it, one without its walk clip, and its
 * colour map, which stands in for a baked face map (material 0).
 */
async function models() {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const document = await io.read(FIGURE);
  await document.transform(
    dequantize(),
    unpartition(),
    textureCompress({ encoder: sharp, targetFormat: 'png', resize: [256, 256] }),
  );
  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (PACKAGE_ONLY.includes(extension.extensionName)) extension.dispose();
  }
  const write = async () => Buffer.from(await io.writeBinary(document));
  const first = await write();
  document.getRoot().getAsset().generator = 'e2e: sealed again';
  const second = await write();
  for (const clip of document.getRoot().listAnimations()) if (/walk/i.test(clip.getName())) clip.dispose();
  const face = Buffer.from(document.getRoot().listMaterials()[0].getBaseColorTexture().getImage());
  return { first, second, noWalk: await write(), face };
}

/** What the studio's model-stats answer counts, read from a GLB's JSON chunk. */
function stats(bytes) {
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
  const count = (accessor) => json.accessors?.[accessor]?.count ?? 0;
  const primitives = (json.meshes ?? []).flatMap((mesh) => mesh.primitives);
  return {
    triangles: primitives.reduce(
      (sum, primitive) => sum + Math.floor(count(primitive.indices ?? primitive.attributes.POSITION) / 3),
      0,
    ),
    vertices: primitives.reduce((sum, primitive) => sum + count(primitive.attributes.POSITION), 0),
    meshes: json.meshes?.length ?? 0,
    materials: json.materials?.length ?? 0,
    bones: Math.max(0, ...(json.skins ?? []).map((skin) => skin.joints.length)),
    texture_images: json.images?.length ?? 0,
    animations: json.animations?.length ?? 0,
    file_bytes: bytes.length,
    expected_sha256: sha256(bytes),
  };
}

const picture = (color) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><circle cx="400" cy="400" r="300" fill="${color}"/></svg>`,
    ),
  )
    .png()
    .toBuffer();

/**
 * Starts the fake on `port` (0 for any free one). `reseal(name)` seals that character's job again as a new assembly
 * version with its own face, as remaking it in the studio would.
 */
export async function startFakeCharacterServer({ port = 0 } = {}) {
  const { first, second, noWalk, face: faceMap } = await models();
  const keys = {
    apiKey: randomBytes(18).toString('hex'),
    gatewayKey: randomBytes(18).toString('hex'),
    // Base64 of 48 bytes: the Rust server and auth.py both sign with the decoded bytes.
    jwtSecret: randomBytes(48).toString('base64'),
  };
  const jwtKey = Buffer.from(keys.jwtSecret, 'base64');
  const problems = [];
  const created = (day) => `2026-09-${day}T09:00:00Z`;
  /** Each job's record and, per sealed version, its model, chosen face and front render. */
  const jobs = [
    {
      id: hex('hero'),
      character: `char-${hex('hero-character').slice(0, 12)}`,
      name: 'E2E 모개',
      created: created(21),
      stage: 'complete',
      current: hex('hero:v1'),
      versions: { [hex('hero:v1')]: { model: first, face: hex('hero:v1:smile'), front: await picture('#7cc4a4') } },
    },
    {
      id: hex('statue'),
      character: `char-${hex('statue-character').slice(0, 12)}`,
      name: 'E2E 걷지 않는 모개',
      created: created(20),
      stage: 'expressions',
      current: hex('statue:v1'),
      versions: { [hex('statue:v1')]: { model: noWalk, face: null, front: await picture('#b9a3e3') } },
    },
    // Still being assembled: listed in the studio, never offered for import.
    {
      id: hex('wip'),
      character: `char-${hex('wip-character').slice(0, 12)}`,
      name: 'E2E 조립 중',
      created: created(22),
      stage: 'assemble',
      current: null,
      versions: {},
    },
  ];
  const hero = jobs[0];
  const bodyVersion = hero.current;
  const body = hero.versions[bodyVersion].model;
  const byId = (id) => jobs.find((job) => job.id === id);
  const frontOf = (job) => (job.current ? job.versions[job.current].front : null);

  function record(job) {
    const busy = job.stage === 'assemble';
    const message = { complete: '조립 완료', expressions: '표정 준비 중', assemble: '파츠 조립 중' }[job.stage];
    const sealed = job.current && job.versions[job.current];
    const native = (name) => `/api/avatar-factory/jobs/${job.id}/native-parts/${job.current}/${name}`;
    return {
      id: job.id,
      character_id: job.character,
      character_name: job.name,
      source_sha256: sha256(job.id),
      created_at: job.created,
      updated_at: job.created,
      status: busy ? 'pipeline_running' : 'complete',
      input_kind: 'image',
      production_mode: 'character_parts',
      requested_slots: ['body'],
      assembly_version: job.current,
      assembly_origin: sealed ? 'generated_parts_fitted_to_meshy_body' : null,
      assembly_artifacts: sealed
        ? ['model.glb', 'body.glb'].map((name) => ({ name, url: native(name), sha256: sha256(sealed.model) }))
        : [],
      artifacts: [
        { name: 'body-front.png', url: `/api/avatar-factory/jobs/${job.id}/artifacts/body-front.png`, sha256: sha256(job.id) },
      ],
      parts: [
        { slot: 'body', image_status: 'succeeded', model_status: 'SUCCEEDED', assembly_status: sealed ? 'complete' : 'running' },
      ],
      character_flow: {
        status: busy ? 'running' : job.stage === 'complete' ? 'complete' : 'ready',
        stage: job.stage,
        message,
        busy,
      },
      progress: { stage: job.stage, message },
      next_actions: [],
    };
  }
  /** A sealed version's faces: the chosen one's map (material 0) and its model with the face baked in. */
  const faceFiles = (sealed) => ({ 'model.glb': sealed.model, 'face-0.png': faceMap });
  const expressions = (job, version) => {
    const sealed = job.versions[version];
    if (!sealed) return null;
    const items = sealed.face
      ? [
          {
            id: sealed.face,
            name: 'smile',
            layout: { eye: 0.5, mouth: 0.5, spacing: 0.5, size: 0.5 },
            materials: [{ material: 0, file: 'face-0.png' }],
            artifacts: Object.entries(faceFiles(sealed)).map(([name, bytes]) => ({
              name,
              sha256: sha256(bytes),
              url: `/api/studio/bodies/${job.id}/${version}/expressions/${sealed.face}/${name}`,
            })),
          },
        ]
      : [];
    return { items, selected: sealed.face, revision: sealed.face ? hex(`${sealed.face}:selected`) : '0' };
  };
  /** The fitted assembly of a job, as the parts and photo screens read it. */
  const nativeParts = (job) => {
    const sealed = job.current && job.versions[job.current];
    if (!sealed) return { status: 'running', parts: [], artifacts: [] };
    const files = {
      'model.glb': sealed.model,
      'body.glb': sealed.model,
      'front.png': sealed.front,
      'body-front.png': sealed.front,
    };
    const artifacts = Object.entries(files).map(([name, bytes]) => ({
      name,
      url: `/api/avatar-factory/jobs/${job.id}/native-parts/${job.current}/${name}`,
      sha256: sha256(bytes),
    }));
    const { bones } = stats(sealed.model);
    return {
      status: 'review_required',
      version: job.current,
      origin: 'generated_parts_fitted_to_meshy_body',
      rigged: true,
      bone_count: bones,
      parts: [{ slot: 'body', objects: ['Body'], available: true }],
      artifacts,
    };
  };
  /** Which production stages could run again: none here, since everything is saved or still running. */
  const stages = (job) => {
    const busy = job.stage === 'assemble';
    const reason = busy ? '진행 중인 단계가 끝난 뒤 실행할 수 있습니다.' : '저장된 결과가 있습니다.';
    return {
      busy,
      recommended_stage: null,
      operation: null,
      actions: ['images', 'models', 'rig', 'assemble', 'expressions'].map((stage) => ({
        stage,
        enabled: false,
        reason,
        paid: stage !== 'assemble',
      })),
      saved: { images: 1, images_total: 1, models: 1, models_total: 1, rig: !busy },
    };
  };
  /** The photo each character was made from, as `/api/characters` lists it. */
  const character = (job) => ({
    id: job.character,
    name: job.name,
    revision: hex(`${job.character}:revision`),
    height_meters: null,
    pipeline_status: 'complete',
    rig_origin: 'meshy',
    model_id: null,
    model_sha256: null,
    operation: null,
    problems: [],
    next_actions: [],
    inspection: {},
    parts: [],
    body_coverage: 'unknown',
    review: {},
    provider: { stage: null, status: null, progress: null, task_id: null, http_status: null },
    motion_pack: { status: null, submitted_tasks: 0, max_new_tasks: null, clips: {}, tasks: {} },
    artifacts: [
      {
        id: 'reference',
        kind: 'image',
        bytes: (frontOf(job) ?? frontOf(hero)).length,
        url: `/api/characters/${job.character}/artifacts/reference`,
      },
    ],
  });
  // No provider keys: the screens show generation as unavailable, and nothing can start paid work.
  const capabilities = {
    character_pipeline: 'parts_to_character_v2',
    ready: false,
    image_configured: false,
    meshy_configured: false,
    tripo_configured: false,
    blender_available: false,
    storage_configured: true,
    model_providers: [],
    default_model_provider: 'meshy',
    meshy_balance: null,
    meshy_credit_estimate: { part: 20, rig: 5 },
    part_methods: { defaults: {} },
    image_provider: 'openai',
    image_model: 'gpt-image-1',
    meshy_model: 'meshy-7.1',
    slots: ['face', 'hairBack', 'hairFront', 'hat', 'top', 'bottom', 'shoes', 'body', 'hair'],
    design_prompt_defaults: {},
    next_actions: ['produce_images', 'produce_prepared'].map((id) => ({
      id,
      enabled: false,
      reason: '서버 설정 필요: OpenAI 키, Meshy 키',
    })),
  };
  const wardrobeBody = {
    job_id: hero.id,
    version: bodyVersion,
    profile_id: `body-${hex('body')}`,
    body_sha256: sha256(body),
    geometry_sha256: sha256(`${hero.id}:geometry`),
    name: hero.name,
    body_type: 'female',
    registered_at: created(21),
  };

  /** The studio's API by path (below /api/), each answering `[status, body]`, a file, or a redirect. */
  const routes = [
    ['avatar-factory/jobs', () => [200, { jobs: jobs.map(record) }]],
    ['avatar-factory/jobs/:job', ({ job }) => job && [200, record(job)]],
    [
      'avatar-factory/jobs/:job/artifacts/body-front.png',
      ({ job }) => job && { file: frontOf(job) ?? hero.versions[bodyVersion].front, type: 'image/png' },
    ],
    [
      'avatar-factory/jobs/:job/model-stats',
      ({ job }, query) => {
        const sealed = job?.versions[query.get('version')];
        return sealed && [200, stats(sealed.model)];
      },
    ],
    [
      'avatar-factory/jobs/:job/native-parts/:version/:file',
      ({ job, version, file }) => {
        const sealed = job?.versions[version];
        if (!sealed) return null;
        if (['front.png', 'body-front.png'].includes(file)) return { file: sealed.front, type: 'image/png' };
        return ['model.glb', 'body.glb'].includes(file) && { file: sealed.model, type: 'model/gltf-binary' };
      },
    ],
    ['avatar-factory/jobs/:job/native-parts', ({ job }) => job && [200, nativeParts(job)]],
    ['avatar-factory/jobs/:job/stages', ({ job }) => job && [200, stages(job)]],
    [
      'avatar-factory/jobs/:job/rig-transfer',
      ({ job }) => job && [200, { status: 'not_started', can_start: false, recommended_source: null }],
    ],
    ['avatar-factory/rig-transfer/sources', () => [200, { items: [] }]],
    ['avatar-factory/capabilities', () => [200, capabilities]],
    ['characters', () => [200, { characters: jobs.map(character) }]],
    [
      'characters/:character/artifacts/reference',
      ({ character: id }) => {
        const job = jobs.find((candidate) => candidate.character === id);
        return job && { file: frontOf(job) ?? frontOf(hero), type: 'image/png' };
      },
    ],
    [
      'avatar-factory/body-profile',
      () => [
        200,
        {
          revision: hex('profile'),
          body: {
            job_id: hero.id,
            version: bodyVersion,
            profile_id: wardrobeBody.profile_id,
            body_sha256: wardrobeBody.body_sha256,
          },
        },
      ],
    ],
    [
      'avatar-factory/wardrobe/bodies',
      () => [
        200,
        {
          revision: hex('bodies'),
          bodies: [{ ...wardrobeBody, is_default: true, part_jobs: 0 }],
          default: { job_id: hero.id, version: bodyVersion },
        },
      ],
    ],
    ['avatar-factory/wardrobe/bodies/:job/parts', ({ job }) => job === hero && [200, { body: wardrobeBody, parts: [] }]],
    ['avatar-factory/wardrobe/outfits', () => [200, { revision: '0', outfits: {} }]],
    [
      'studio/catalog',
      () => [
        200,
        {
          revision: hex('catalog'),
          items: {},
          characters: {},
          parts: Object.fromEntries(jobs.map((job) => [`${job.id}:body`, { name: job.name }])),
        },
      ],
    ],
    [
      'studio/bodies/:job/:version/expressions',
      ({ job, version }) => job && expressions(job, version) && [200, expressions(job, version)],
    ],
    // Faces live in object storage: the character server answers with a presigned redirect.
    [
      'studio/bodies/:job/:version/expressions/:face/:file',
      ({ job, version, face, file }) => {
        const sealed = job?.versions[version];
        return sealed?.face === face && faceFiles(sealed)[file] && { redirect: `/signed/${job.id}/${version}/${face}/${file}` };
      },
    ],
    [
      'studio/bodies/:job/:version/expression-generations',
      ({ job, version }) =>
        job?.versions[version] && [
          200,
          {
            items: [],
            batches: [],
            reference: { revision: '0', assets: [] },
            capabilities: { ready: false, reason: 'S3와 OpenAI 이미지 생성 연결이 필요합니다.' },
            defaults: Object.fromEntries(
              ['neutral', 'smile', 'cry', 'angry', 'surprise', 'blink'].map((name) => [name, `${name} face`]),
            ),
          },
        ],
    ],
    [
      'avatar-factory/jobs/:job/native-outfits/:version',
      ({ job, version }) => {
        const sealed = job?.versions[version];
        // Only the body is assembled, so nothing is worn over it.
        return sealed && [200, { version, body_sha256: sha256(sealed.model), revision: '0', slots: [] }];
      },
    ],
  ];
  /** What the presigned links point at: a sealed version's face files. */
  const signed = (path) => {
    const [id, version, face, name] = path.split('/');
    const sealed = byId(id)?.versions[version];
    return sealed?.face === face ? faceFiles(sealed)[name] : null;
  };

  function unsigned(request) {
    const { authorization = '', cookie } = request.headers;
    if (request.headers['x-api-key'] !== keys.apiKey) return 'no API key';
    if (request.headers['x-gateway-key'] !== keys.gatewayKey) return 'no gateway key';
    if (cookie) return 'a browser cookie';
    const [header, payload, signature] = authorization.replace(/^Bearer /, '').split('.');
    if (!payload || createHmac('sha256', jwtKey).update(`${header}.${payload}`).digest('base64url') !== signature)
      return 'a bad operator token';
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const valid =
      claims.iss === ISSUER && claims.aud === AUDIENCE && claims.roles?.includes('ADMIN') && claims.exp * 1000 > Date.now();
    return valid ? null : 'operator token claims auth.py would refuse';
  }

  function answer(request, response) {
    const url = new URL(request.url, 'http://fake');
    const send = (status, body, headers = {}) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (url.pathname.startsWith('/signed/')) {
      const bytes = request.method === 'GET' && signed(url.pathname.slice('/signed/'.length));
      // Presigned object storage answers the browser too (the admin page's 3D preview), from another origin.
      const type = url.pathname.endsWith('.png') ? 'image/png' : 'model/gltf-binary';
      return bytes
        ? send(200, bytes, { 'content-type': type, 'access-control-allow-origin': '*' })
        : send(404, { detail: 'Not Found' });
    }
    const path = url.pathname.replace(/^\/api\//, '');
    const refusal = url.pathname.startsWith('/api/') ? unsigned(request) : 'not an API path';
    if (refusal) {
      problems.push(`fake character server: ${request.method} ${url.pathname} refused, ${refusal}`);
      return send(401, { detail: 'Not authenticated' });
    }
    const segments = path.split('/');
    for (const [pattern, handle] of request.method === 'GET' ? routes : []) {
      const wanted = pattern.split('/');
      if (wanted.length !== segments.length) continue;
      const params = {};
      const matches = wanted.every((part, index) => {
        if (!part.startsWith(':')) return part === segments[index];
        params[part.slice(1)] = part === ':job' ? byId(segments[index]) : segments[index];
        return true;
      });
      if (!matches) continue;
      const result = handle(params, url.searchParams);
      if (!result) return send(404, { detail: 'Not Found' });
      if (Array.isArray(result)) return send(result[0], result[1]);
      if (result.redirect)
        return send(307, '', {
          location: `http://${request.headers.host}${result.redirect}`,
          'cache-control': 'private, no-store',
        });
      return send(200, result.file, { 'content-type': result.type, 'content-length': result.file.length });
    }
    problems.push(`fake character server: nothing answers ${request.method} ${url.pathname}`);
    return send(404, { detail: 'Not Found' });
  }

  const server = createServer((request, response) => {
    try {
      answer(request, response);
    } catch (error) {
      problems.push(`fake character server: ${request.method} ${request.url} failed: ${error.message}`);
      if (!response.headersSent) response.writeHead(500).end();
    }
  });
  await new Promise((done) => server.listen(port, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    keys,
    jwt: { issuer: ISSUER, audience: AUDIENCE },
    problems,
    /** The characters as the admin page names them. */
    names: { hero: hero.name, noWalk: jobs[1].name, unfinished: jobs[2].name },
    reseal(name) {
      const job = jobs.find((candidate) => candidate.name === name);
      const version = hex(`${job.id}:${Object.keys(job.versions).length + 1}`);
      job.versions[version] = { model: second, face: hex(`${version}:smile`), front: frontOf(job) };
      job.current = version;
    },
    close: () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const fake = await startFakeCharacterServer({ port: Number(process.argv[2] ?? 0) });
  if (process.send) {
    // Forked by scripts/character-e2e.mjs: each message may re-seal a character and is answered with the problems seen
    // so far. It ends with the test.
    const { url, keys, jwt, names } = fake;
    process.send({ ready: { url, keys, jwt, names } });
    process.on('message', ({ id, reseal }) => {
      if (reseal) fake.reseal(reseal);
      process.send({ id, problems: fake.problems });
    });
    process.on('disconnect', () => process.exit());
  } else {
    console.log(`fake character server at ${fake.url}; run the Rust server with
FACTORY_URL=${fake.url}
FACTORY_API_KEY=${fake.keys.apiKey}
FACTORY_GATEWAY_KEY=${fake.keys.gatewayKey}
FACTORY_JWT_SECRET=${fake.keys.jwtSecret}`);
    setInterval(() => fake.problems.splice(0).forEach((problem) => console.warn(problem)), 1000);
  }
}
