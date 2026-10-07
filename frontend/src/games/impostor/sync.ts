import { useEffect, useRef } from 'react';

import { standFor, useArenaTrip } from '../arena';
import type { GameProps } from '../game';
import { useHidePeers } from '../hiddenPeers';
import { useQuietRoom } from '../quiet';
import type { ImpostorView } from './index';

/**
 * What the viewer's page does by itself while 임포스터 is on: the viewer is taken to their place by the table as the
 * game starts (the ship has taken the island's place, see ship.ts; whoever watches to its stand) and back to where they
 * stood on the island when it is over, to their seat when a meeting starts, and to the vent they move to, once each;
 * and a player does not talk in the island's live room between meetings. The live room itself hides the dead from the
 * living and whoever is in a vent; a server from before it did (a release rolled back) names them in the view instead,
 * and the island leaves their avatars out. The game's World mounts it: that stays while the game is on, panel open or
 * not.
 */
export function useImpostorSync({
  view,
  session,
  teleport,
  position,
  body,
  trip,
  setTrip,
}: Pick<GameProps<ImpostorView>, 'view' | 'session' | 'teleport' | 'position' | 'body' | 'trip' | 'setTrip'>) {
  // To the table at the start (to the stand, watching), back to the island once it is over (or the viewer has left).
  const entry = view.phase !== 'ended' ? (view.spawn ?? standFor(session)) : null;
  useArenaTrip(entry, { session, teleport, position, body, trip, setTrip });

  const named = view.phase !== 'ended' && Array.isArray(view.hidden) ? view.hidden : [];
  const peers = named.filter((id) => id !== session.you).map((id) => session.players.find((player) => player.id === id)?.peer);
  useHidePeers('impostor', peers);

  const plays = view.role !== null && view.phase === 'play';
  useQuietRoom('impostor', plays);

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
