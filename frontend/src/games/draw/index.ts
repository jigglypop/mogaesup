import { defineGame } from '../game';
import { DrawPanel, DrawRanking } from './Panel';

/**
 * 캐치마인드 as the server shows it (server/src/games/draw.rs). The strokes are not in it: they come as events, and a
 * panel that opens mid-turn asks for them with `{"replay": true}`.
 */
export type DrawView = {
  /** The turn being drawn, or the pause after it that shows its word. */
  phase: 'drawing' | 'reveal';
  /** From 1. */
  turn: number;
  turns: number;
  /** User id of whoever draws this turn. */
  drawer: string;
  role: 'drawer' | 'guesser' | 'watcher';
  /** The drawer's alone while the turn lasts, everyone's in the pause; null otherwise. */
  word: string | null;
  /** The word's syllables. */
  letters: number;
  /** In the order the players joined. */
  scores: { id: string; name: string; score: number }[];
  /** Who has guessed this turn's word, in order. */
  guessed: string[];
  /** On the server's clock: when the turn, or the pause, ends. */
  endsAt: number;
};
export type DrawResult = { ranking: { id: string; name: string; score: number; rank: number }[] };

/** Draw and guess: everyone draws once in turn while the others guess the word. */
export const draw = defineGame<DrawView, DrawResult>({
  kind: 'draw',
  label: '캐치마인드',
  minPlayers: 2,
  maxPlayers: 12,
  // Nothing on the island is needed.
  layout: () => ({}),
  Panel: DrawPanel,
  Result: DrawRanking,
});
