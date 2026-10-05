import { describe, expect, it } from 'vitest';

import { GAMES, gameOf } from '../registry';

describe('게임 등록', () => {
  it('게임마다 고유한 kind와 서버가 지키는 인원 범위를 가진다', () => {
    expect(new Set(GAMES.map((game) => game.kind)).size).toBe(GAMES.length);
    for (const game of GAMES) {
      expect(game.kind).toMatch(/^[a-z0-9_-]{1,32}$/);
      expect(game.label.trim()).not.toBe('');
      expect(game.minPlayers).toBeGreaterThanOrEqual(1);
      expect(game.maxPlayers).toBeGreaterThanOrEqual(game.minPlayers);
      expect(game.maxPlayers).toBeLessThanOrEqual(30);
      expect(gameOf(game.kind)).toBe(game);
    }
    expect(gameOf('nope')).toBeNull();
    expect(gameOf(undefined)).toBeNull();
  });
});
