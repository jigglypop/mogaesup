// Writes the server migration that lists generated props as built-in island furniture: one published catalog_items row
// per scripts/props/manifest.json item, with the model and picture scripts/props-normalize.mjs wrote
// (/gltf/decor/<id>.glb, /gltf/decor/thumbs/<id>.webp), the manifest's `name` and `emoji`, and an order by `shelf`.
// Every island owner then finds them in the decorating drawer's studio shelf, and admins can rename, reorder or retire
// them in the catalog screen: a row only ever goes in once (ON CONFLICT DO NOTHING), so those edits stay.
// Usage: node scripts/props-catalog.mjs <server/migrations/YYYYMMDDHHMMSS_name.sql> [ids...]
// (default: every manifest item no migration lists yet). An applied migration must never change, so it will not
// overwrite a file: a later batch is a new migration.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrations = resolve(frontend, '../server/migrations');
const manifest = JSON.parse(readFileSync(resolve(frontend, '../scripts/props/manifest.json'), 'utf8'));
/** Drawer order: each shelf's props follow the manifest's order from its base, after the studio's own (sort 100). */
const SHELVES = ['furniture', 'garden', 'farm', 'flowers', 'rocks', 'plants'];
const SHELF_BASE = 2000;
const SHELF_STEP = 100;
/** catalog.rs: `catalog_id`, and the label and emoji lengths the admin screen allows. */
const ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const LABEL_MAX = 30;
const EMOJI_MAX = 16;

const [output, ...ids] = process.argv.slice(2);
if (!output || !/^\d{14}_[a-z0-9_]+\.sql$/.test(basename(output))) {
  throw new Error('usage: node scripts/props-catalog.mjs <server/migrations/YYYYMMDDHHMMSS_name.sql> [ids...]');
}
if (existsSync(output)) throw new Error(`${output} exists; an applied migration must not change, so write a new one`);

const catalogId = (item) => `prop-${item.id}`;
const listed = new Set(
  readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .flatMap((name) => [...readFileSync(join(migrations, name), 'utf8').matchAll(/'(prop-[a-z0-9_-]+)'/g)].map((match) => match[1])),
);
const unknown = ids.filter((id) => !manifest.items.some((item) => item.id === id));
if (unknown.length) throw new Error(`not in scripts/props/manifest.json: ${unknown.join(', ')}`);
const items = ids.length ? manifest.items.filter((item) => ids.includes(item.id)) : manifest.items.filter((item) => !listed.has(catalogId(item)));
if (!items.length) throw new Error('every manifest item is in a migration already');

const sql = (text) => `'${text.replaceAll("'", "''")}'`;
const rows = items.map((item) => {
  const id = catalogId(item);
  const model = `/gltf/decor/${item.id}.glb`;
  const picture = `/gltf/decor/thumbs/${item.id}.webp`;
  const problems = [
    listed.has(id) && 'listed by another migration',
    !ID.test(id) && 'id is no catalog id',
    !item.name || [...item.name].length > LABEL_MAX ? `name needs 1-${LABEL_MAX} characters` : '',
    manifest.items.some((other) => other !== item && other.name === item.name) && `name ${item.name} is taken by another prop`,
    !item.emoji || [...item.emoji].length > EMOJI_MAX ? `emoji needs 1-${EMOJI_MAX} characters` : '',
    !SHELVES.includes(item.shelf) && `shelf is none of ${SHELVES.join(', ')}`,
    !existsSync(join(frontend, 'public', model)) && `no ${model} (run scripts/props-normalize.mjs)`,
    !existsSync(join(frontend, 'public', picture)) && `no ${picture} (run scripts/props-normalize.mjs)`,
  ].filter(Boolean);
  if (problems.length) throw new Error(`${item.id}: ${problems.join('; ')}`);
  const shelf = manifest.items.filter((other) => other.shelf === item.shelf);
  const order = SHELF_BASE + SHELVES.indexOf(item.shelf) * SHELF_STEP + shelf.indexOf(item);
  return { order, line: `  (${[sql(id), "'furniture'", sql(item.name), sql(item.emoji), sql(model), sql(picture), "'builtin'", "'published'", order].join(', ')})` };
});
rows.sort((a, b) => a.order - b.order);

const text = [
  '-- Island props made with scripts/props (generate.py, then frontend/scripts/props-normalize.mjs) as built-in furniture',
  "-- in every island's decorating drawer. Written by frontend/scripts/props-catalog.mjs; a row only goes in once, so",
  '-- what admins change in the catalog screen (name, order, retiring) stays.',
  'INSERT INTO catalog_items (id, kind, label, emoji, model_url, thumbnail_url, source, status, sort_order) VALUES',
  rows.map((row) => row.line).join(',\n'),
  'ON CONFLICT (id) DO NOTHING;',
  '',
].join('\n');
writeFileSync(output, text, 'utf8');
console.log(`${output}: ${rows.length} props`);
