import { vi } from 'vitest';

import { createIslandSaver, type IslandSaverOptions } from '../edit/save';

/** A save system whose domains move when `edit()` is called and whose writes answer as told, then as `failing` says. */
export function fakeWorld() {
  const revisions = { building: 1, 'gameplay-events': 1 };
  const answers: (Error | null)[] = [];
  const failing: { with: Error | null } = { with: null };
  const system = {
    save: vi.fn(async () => {
      const answer = answers.length ? answers.shift() : failing.with;
      if (answer) throw answer;
    }),
    load: vi.fn(async () => true),
    getBindings: () =>
      (Object.keys(revisions) as (keyof typeof revisions)[]).map((key) => ({
        key,
        serialize: () => null,
        hydrate: () => {},
        revision: () => revisions[key],
      }))[Symbol.iterator](),
  } as unknown as IslandSaverOptions['system'] & { save: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn> };
  const adapter = { refreshRevision: vi.fn(async () => {}), lastBytes: 1234, revision: 0 };
  return {
    system,
    adapter,
    answers,
    failing,
    edit(key: keyof typeof revisions = 'building') {
      revisions[key]++;
    },
  };
}

/** A saver on that world, loaded and ready to track edits. */
export const ready = async (world: ReturnType<typeof fakeWorld>, options: Partial<IslandSaverOptions> = {}) => {
  const saver = createIslandSaver({ system: world.system, adapter: world.adapter, writable: true, ...options });
  await saver.load();
  return saver;
};
