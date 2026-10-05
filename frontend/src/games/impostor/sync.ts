import { useEffect, useRef, useState } from 'react';

import type { GameProps } from '../game';
import { useHidePeers } from '../hiddenPeers';
import type { ImpostorView } from './index';

/**
 * What the viewer's page does by itself while 임포스터 is on: the avatars the server says the viewer does not see (the
 * dead to the living, anyone in a vent) stay hidden, the dead even after they leave the game, until it ends; the viewer
 * is moved to their place at the table as the game starts, to their seat when a meeting starts, and to the vent they
 * move to, once each. The game's World mounts it: that stays while the game is on, panel open or not.
 */
export function useImpostorSync({ view, session, teleport }: Pick<GameProps<ImpostorView>, 'view' | 'session' | 'teleport'>) {
  // The live-room peers of those hidden, by player, kept once they have left the game.
  const [known, setKnown] = useState<Readonly<Record<string, string>>>({});
  const seen: Record<string, string> = {};
  for (const { id, peer } of session.players) {
    if (peer && id !== session.you && known[id] !== peer) seen[id] = peer;
  }
  if (Object.keys(seen).length) setKnown({ ...known, ...seen });
  const hide = view.phase !== 'ended' ? view.hidden.filter((id) => id !== session.you).map((id) => known[id] ?? seen[id]) : [];
  useHidePeers('impostor', hide);

  const spawned = useRef(false);
  useEffect(() => {
    if (spawned.current || !view.spawn) return;
    if (teleport(view.spawn)) spawned.current = true;
  }, [view.spawn, teleport]);

  const seated = useRef<number | null>(null);
  const { meeting } = view;
  useEffect(() => {
    if (!meeting?.seat || seated.current === meeting.number) return;
    if (teleport(meeting.seat)) seated.current = meeting.number;
  }, [meeting, teleport]);

  const vented = useRef<number | null>(null);
  const vent = view.venting;
  const place = vent === null ? null : view.vents[vent];
  useEffect(() => {
    if (vent === null || !place) {
      vented.current = null;
      return;
    }
    if (vented.current === vent) return;
    if (teleport(place)) vented.current = vent;
  }, [vent, place, teleport]);
}
