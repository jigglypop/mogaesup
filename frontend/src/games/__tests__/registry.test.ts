import { describe, expect, it } from 'vitest';

import { createVillage } from '../../minihome/village';
import { GAMES, gameOf } from '../registry';
import { openSpots } from '../spots';
import type { GameSession } from '../protocol';

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

  it('보물찾기의 배치는 모개숲의 빈 자리다', () => {
    const building = createVillage();
    const session = { kind: 'treasure' } as GameSession;
    const layout = gameOf('treasure')!.layout({ building, spots: () => openSpots(building, { bounds: () => undefined }), position: null, session });
    expect(layout).toEqual({ spots: openSpots(building, { bounds: () => undefined }) });
  });
});
