import { readFileSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PetBrain } from '../brain/brain';
import { ablateGraph, parsePetGraph, type PetGraph } from '../brain/graph';
import { mastery } from '../brain/probes';
import type { PetCommand } from '../brain/senses';
import { train, type TrainingResult } from '../brain/trainer';

/**
 * Learning with a scripted owner (`trainer.ts`): command, a treat or praise a second after the right response, nothing
 * for a wrong trick, three seconds of free time between trials. Seeds 1–6, 50 fixed probes per check. The limits are
 * the design's (60 trials for sit alone, 300 for five commands mixed); the measured runs sit well inside them.
 *
 * `PETS_REPORT=1 npx vitest run src/pets/__tests__/learning.test.ts` prints the per-seed tables, the control with the
 * circuit's connections removed included.
 */
const graph = parsePetGraph(JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../brain/malecns-dna02-128.json'), 'utf8')));
const control = ablateGraph(graph);
const SEEDS = [1, 2, 3, 4, 5, 6];
const PROBES = 50;
const SIT_LIMIT = 60;
const MIXED_LIMIT = 300;
const MIXED: PetCommand[] = ['sit', 'down', 'speak', 'come', 'stay'];
const REPORT = process.env['PETS_REPORT'] === '1';

type Run = { seed: number; brain: PetBrain; result: TrainingResult; ms: number };
const runs = new Map<string, Run[]>();

function trainAll(name: string, circuit: PetGraph, commands: PetCommand[], maxTrials: number, checkEvery: number): Run[] {
  const key = `${name}:${circuit.id}`;
  let found = runs.get(key);
  if (!found) {
    found = SEEDS.map((seed) => {
      const brain = PetBrain.create(circuit, seed);
      const started = performance.now();
      const result = train(brain, { commands, maxTrials, probes: PROBES, checkEvery });
      return { seed, brain, result, ms: performance.now() - started };
    });
    runs.set(key, found);
  }
  return found;
}
const sitRuns = (circuit: PetGraph) => trainAll('sit', circuit, ['sit'], SIT_LIMIT, 1);
const mixedRuns = (circuit: PetGraph) => trainAll('mixed', circuit, MIXED, MIXED_LIMIT, 5);

const percent = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);
const trials = (value: number | null) => (value === null ? '-' : String(value));
const pad = (cells: (string | number)[], widths: number[]) => cells.map((cell, i) => String(cell).padStart(widths[i] ?? 6)).join(' ');

describe('반려견식 훈련', () => {
  it('앉아만 가르치면 시드 6개 모두 60번 안에 명령에 앉고 명령 없이는 앉지 않는다', () => {
    for (const { seed, result } of sitRuns(graph)) {
      const sit = result.commands[0]!;
      expect(result.learnedAt, `seed ${seed}`).not.toBeNull();
      expect(result.learnedAt!).toBeLessThanOrEqual(SIT_LIMIT);
      expect(sit.mastery).toBeGreaterThanOrEqual(0.8);
      expect(sit.uncued!).toBeLessThanOrEqual(0.2);
    }
  }, 60_000);

  it('다섯 명령을 섞어 가르치면 시드 6개 모두 300번 안에 다섯 명령을 함께 익힌다', () => {
    for (const { seed, result } of mixedRuns(graph)) {
      expect(result.learnedAt, `seed ${seed}`).not.toBeNull();
      expect(result.learnedAt!).toBeLessThanOrEqual(MIXED_LIMIT);
      for (const command of result.commands) {
        expect(command.mastery, `seed ${seed} ${command.command}`).toBeGreaterThanOrEqual(0.8);
        if (command.uncued !== null) expect(command.uncued).toBeLessThanOrEqual(0.2);
      }
    }
  }, 60_000);

  it('회로 연결을 지운 대조군도 같은 한도 안에 배운다 (학습은 판독 가중치에서 일어난다)', () => {
    for (const { seed, result } of sitRuns(control)) {
      expect(result.learnedAt, `control seed ${seed}`).not.toBeNull();
      expect(result.learnedAt!).toBeLessThanOrEqual(SIT_LIMIT);
    }
    for (const { seed, result } of mixedRuns(control)) {
      expect(result.learnedAt, `control seed ${seed}`).not.toBeNull();
      expect(result.learnedAt!).toBeLessThanOrEqual(MIXED_LIMIT);
    }
  }, 60_000);

  it('익힌 뒤 보상 없이 40번 시키면 덜 따른다', () => {
    const extinction = sitRuns(graph).map(({ seed, brain }) => {
      const copy = PetBrain.decode(graph, seed, brain.encode());
      const before = mastery(copy, 'sit', PROBES);
      train(copy, { commands: ['sit'], maxTrials: 40, probes: PROBES, rewardRight: false, stopWhenLearned: false, checkEvery: 1000, seed: seed + 100 });
      return { seed, before, after: mastery(copy, 'sit', PROBES) };
    });
    for (const { seed, before, after } of extinction) expect(after, `seed ${seed}`).toBeLessThanOrEqual(before - 0.3);

    if (!REPORT) return;
    const lines: string[] = [];
    const sitTable = (title: string, circuit: PetGraph) => {
      lines.push(title, pad(['seed', 'trials', 'treats', 'praise', 'sit', 'unasked', 'ms'], [4, 7, 7, 7, 6, 8, 6]));
      for (const { seed, result, ms } of sitRuns(circuit)) {
        const sit = result.commands[0]!;
        lines.push(pad([seed, trials(result.learnedAt), result.treats, result.praises, percent(sit.mastery), percent(sit.uncued), ms.toFixed(0)], [4, 7, 7, 7, 6, 8, 6]));
      }
    };
    const mixedTable = (title: string, circuit: PetGraph) => {
      const widths = [4, 6, ...MIXED.map(() => 7), 7, 7, ...MIXED.map(() => 6), 9, 6];
      lines.push(title, pad(['seed', 'all', ...MIXED.map((c) => `${c}@`), 'treats', 'praise', ...MIXED, 'unasked', 'ms'], widths));
      for (const { seed, result, ms } of mixedRuns(circuit)) {
        const unasked = result.commands
          .filter((c) => c.uncued !== null)
          .map((c) => percent(c.uncued))
          .join('/');
        lines.push(
          pad(
            [
              seed,
              trials(result.learnedAt),
              ...result.commands.map((c) => trials(c.learnedAt)),
              result.treats,
              result.praises,
              ...result.commands.map((c) => percent(c.mastery)),
              unasked,
              ms.toFixed(0),
            ],
            widths,
          ),
        );
      }
    };
    lines.push('', 'pet learning report: trials to criterion (obeyed in >= 80% of 50 probes; trick unasked in <= 20%)');
    sitTable(`\nsit only, limit ${SIT_LIMIT} trials, connectome circuit`, graph);
    sitTable(`\nsit only, limit ${SIT_LIMIT} trials, control: circuit connections removed`, control);
    mixedTable(`\nsit, down, speak, come, stay mixed, limit ${MIXED_LIMIT} trials (checked every 5), connectome circuit`, graph);
    mixedTable(`\nsit, down, speak, come, stay mixed, limit ${MIXED_LIMIT} trials (checked every 5), control: connections removed`, control);
    lines.push('\nextinction: sit mastery before -> after 40 unrewarded sit commands');
    for (const { seed, before, after } of extinction) lines.push(`  seed ${seed}: ${percent(before)} -> ${percent(after)}`);
    // Straight to stdout: reporters that hide passing tests' console output (vitest's agent reporter) still show it.
    writeSync(1, `${lines.join('\n')}\n`);
  }, 60_000);
});
