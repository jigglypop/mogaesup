import './balloons.css';

import { useContext, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';

import { context as canvasContext, useFrame, useThree } from '@react-three/fiber';
import type { RapierRigidBody } from '@react-three/rapier';
import { Vector3 } from 'three';

import type { PlayerState } from 'gaesup-world';

import { createBalloonBoard, designOfSpeaker, type BalloonBoard, type Point } from './board';
import { createBalloonDom } from './dom';

type BalloonLayerProps = {
  /** What the room says now, by speaker (`client_id`), the viewer's own line among them. */
  speech: ReadonlyMap<string, string>;
  /** The viewer's own `client_id` in the room, and the balloon they talk in. */
  ownKey: string | null;
  ownDesign: string;
  /** Everyone else in the room, the ones a game hides among them; each balloon is told by its speaker's colour. */
  players: ReadonlyMap<string, PlayerState>;
  hidden: ReadonlySet<string>;
  /** The viewer's body, which their own balloons follow. */
  playerRef: RefObject<RapierRigidBody>;
};

/** A frame longer than this (a tab in the background) counts as this long. */
const LONGEST_FRAME = 0.25;

/**
 * Everyone's speech balloons over the island, drawn by the page in a layer over the canvas (as the engine draws its name
 * tags), so each can have its own design, wrapped Korean lines and a time of its own. Draws nothing outside a canvas.
 */
export function BalloonLayer(props: BalloonLayerProps) {
  return useContext(canvasContext) ? <Balloons {...props} /> : null;
}

function Balloons({ speech, ownKey, ownDesign, players, hidden, playerRef }: BalloonLayerProps) {
  const gl = useThree((state) => state.gl);
  const board = useRef<BalloonBoard | null>(null);
  const latest = useRef({ players, hidden });
  latest.current = { players, hidden };
  const point = useMemo(() => new Vector3(), []);

  useLayoutEffect(() => {
    const host = gl.domElement.parentElement;
    if (!host) return undefined;
    const dom = createBalloonDom(host);
    board.current = createBalloonBoard(dom);
    return () => {
      board.current = null;
      dom.dispose();
    };
  }, [gl]);

  useEffect(() => {
    board.current?.hear(speech, Date.now(), designOfSpeaker(ownKey, ownDesign, latest.current.players), ownKey);
  }, [speech, ownKey, ownDesign]);

  useFrame(({ camera, size }, delta) => {
    const current = board.current;
    if (!current?.busy()) return;
    const own = (): Point | null => playerRef.current?.translation() ?? null;
    current.frame({
      now: Date.now(),
      delta: Math.min(LONGEST_FRAME, delta),
      width: size.width,
      listener: own(),
      locate: (key, mine) => {
        if (mine) return own();
        const state = latest.current.players.get(key);
        return state ? { x: state.position[0], y: state.position[1], z: state.position[2] } : null;
      },
      hidden: (key) => latest.current.hidden.has(key),
      toScreen: ({ x, y, z }) => {
        point.set(x, y, z);
        const distance = point.distanceTo(camera.position);
        point.project(camera);
        if (point.z > 1 || Math.abs(point.x) > 1.2 || Math.abs(point.y) > 1.2) return null;
        return { x: ((point.x + 1) / 2) * size.width, y: ((1 - point.y) / 2) * size.height, distance };
      },
    });
  });
  return null;
}
