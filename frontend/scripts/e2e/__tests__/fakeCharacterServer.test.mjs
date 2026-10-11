// @vitest-environment node
import { createHash, createHmac } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeCharacterServer } from '../fake-character-server.mjs';

let fake;
/** The hero's face files, as its expressions list them. */
let faceFiles;

/** A request signed as the Rust server's gateway signs one. */
function call(path, { method = 'GET', headers = {} } = {}) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iss: fake.jwt.issuer, aud: fake.jwt.audience, roles: ['ADMIN'], exp: Math.floor(Date.now() / 1000) + 600 };
  const token = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(claims)}`;
  const signature = createHmac('sha256', Buffer.from(fake.keys.jwtSecret, 'base64')).update(token).digest('base64url');
  return fetch(`${fake.url}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      authorization: `Bearer ${token}.${signature}`,
      'x-api-key': fake.keys.apiKey,
      'x-gateway-key': fake.keys.gatewayKey,
      ...headers,
    },
  });
}
const bytesOf = async (response) => Buffer.from(await response.arrayBuffer());

beforeAll(async () => {
  fake = await startFakeCharacterServer();
  const { jobs } = await (await call('/api/avatar-factory/jobs')).json();
  const hero = jobs.find((job) => job.character_name === fake.names.hero);
  const { items } = await (await call(`/api/studio/bodies/${hero.id}/${hero.assembly_version}/expressions`)).json();
  faceFiles = items[0].artifacts;
}, 60_000);
afterAll(() => fake?.close());

describe('E2E 가짜 캐릭터 서버의 파일 응답', () => {
  it('표정 파일을 리다이렉트 없이 같은 origin에서 보낸다', async () => {
    expect(faceFiles.map((file) => file.name).sort()).toEqual(['face-0.png', 'model.glb']);
    for (const file of faceFiles) {
      const response = await call(file.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      const bytes = await bytesOf(response);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
      expect(response.headers.get('content-length')).toBe(String(bytes.length));
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    }
  });

  it('HEAD, Range, If-None-Match, If-Range에 캐릭터 서버처럼 답한다', async () => {
    const { url } = faceFiles.find((file) => file.name === 'model.glb');
    const whole = await bytesOf(await call(url));
    const head = await call(url, { method: 'HEAD' });
    expect([head.status, head.headers.get('content-length'), (await bytesOf(head)).length]).toEqual([200, String(whole.length), 0]);
    const etag = head.headers.get('etag');

    const first = await call(url, { headers: { range: 'bytes=0-9' } });
    expect([first.status, first.headers.get('content-range')]).toEqual([206, `bytes 0-9/${whole.length}`]);
    expect(await bytesOf(first)).toEqual(whole.subarray(0, 10));
    expect(await bytesOf(await call(url, { headers: { range: 'bytes=-4' } }))).toEqual(whole.subarray(-4));
    const beyond = await call(url, { headers: { range: `bytes=${whole.length}-` } });
    expect([beyond.status, beyond.headers.get('content-range')]).toEqual([416, `bytes */${whole.length}`]);

    expect((await call(url, { headers: { 'if-none-match': `W/${etag}` } })).status).toBe(304);
    const same = await call(url, { headers: { range: 'bytes=0-9', 'if-range': etag } });
    expect(same.status).toBe(206);
    const changed = await call(url, { headers: { range: 'bytes=0-9', 'if-range': '"another"' } });
    expect([changed.status, (await bytesOf(changed)).length]).toEqual([200, whole.length]);
  });

  it('옷장 파츠는 Blender 내보내기처럼 정점 속성마다 버퍼 뷰를 따로 둔다', async () => {
    const { bodies } = await (await call('/api/avatar-factory/wardrobe/bodies')).json();
    const { parts } = await (await call(`/api/avatar-factory/wardrobe/bodies/${bodies[0].job_id}/parts`)).json();
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      const glb = await bytesOf(await call(`/api/avatar-factory/jobs/${part.job_id}/native-parts/${part.version}/${part.slot}.glb`));
      const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString());
      const views = json.meshes.flatMap((mesh) =>
        mesh.primitives.flatMap((primitive) => Object.values(primitive.attributes).map((index) => json.accessors[index].bufferView)),
      );
      // The wardrobe resizes and moves a part only when its positions are not interleaved with other attributes.
      expect(new Set(views).size).toBe(views.length);
    }
  });

  it('JSON 경로의 HEAD는 405로 답하고 문제로 남긴다', async () => {
    const response = await call('/api/avatar-factory/jobs', { method: 'HEAD' });
    expect(response.status).toBe(405);
    expect(fake.problems).toContain('fake character server: nothing answers HEAD /api/avatar-factory/jobs');
  });
});
