import { useEffect, useRef, useState } from 'react';

import type { GameProps } from '../game';
import { useHidePeers } from '../hiddenPeers';
import type { ImpostorView } from './index';

/**
 * What the viewer's page does by itself while 임포스터 is on: the living (and onlookers) do not see the dead walk, whose
 * avatars stay hidden even after they leave the game, until it ends; and when a meeting starts the viewer is moved to
 * their seat at the table, once. The game's World mounts it: that stays while the game is on, panel open or not.
 */
export function useImpostorSync({ view, session, teleport }: Pick<GameProps<ImpostorView>, 'view' | 'session' | 'teleport'>) {
  // The other dead's live-room peers by player, kept once they have left the game.
  const [ghosts, setGhosts] = useState<Readonly<Record<string, string>>>({});
  const seen: Record<string, string> = {};
  for (const { id, peer } of session.players) {
    if (peer && id !== session.you && view.dead.includes(id) && ghosts[id] !== peer) seen[id] = peer;
  }
  if (Object.keys(seen).length) setGhosts({ ...ghosts, ...seen });
  const hide = view.phase !== 'ended' && view.alive !== false;
  useHidePeers('impostor', hide ? Object.values(ghosts) : []);

  const seated = useRef<number | null>(null);
  const { meeting } = view;
  useEffect(() => {
    if (!meeting?.seat || seated.current === meeting.number) return;
    if (teleport(meeting.seat)) seated.current = meeting.number;
  }, [meeting, teleport]);
}
