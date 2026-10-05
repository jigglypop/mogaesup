import { useMemo, useRef } from 'react';

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import type { Group, Mesh } from 'three';

import type { GameProps } from '../game';
import type { Vec3 } from '../protocol';
import type { ImpostorBot, ImpostorView } from './index';
import { routeAt } from './route';
import { useImpostorSync } from './sync';

/** Markers are left out of picking, so a click on one walks to the ground under it. */
const noRaycast = () => null;
/** A pad's radius, and how high the marker over one of the viewer's own floats, in meters. */
const PAD = 0.8;
const MARK = 1.9;
/** Names over the bots stay under the page's panels. */
const NAME_LAYERS: [number, number] = [12, 0];
const CREW_COLORS = 12;

/** A colour token from tokens.css, for materials the stylesheet cannot reach. */
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

type Colors = {
  pad: string;
  task: string;
  table: string;
  body: string;
  vent: string;
  alarm: string;
  visor: string;
  crew: string[];
};

/** Turns and bobs over a station the viewer still has to work at, to find it from afar. */
function Marker({ at, color }: { at: Vec3; color: string }) {
  const mesh = useRef<Mesh>(null);
  useFrame(({ clock: time }) => {
    const marker = mesh.current;
    if (!marker) return;
    marker.rotation.y = time.elapsedTime * 1.4;
    marker.position.y = at[1] + MARK + Math.sin(time.elapsedTime * 2.2) * 0.1;
  });
  return (
    <mesh ref={mesh} position={[at[0], at[1] + MARK, at[2]]} rotation={[Math.PI, 0, 0]} raycast={noRaycast}>
      <coneGeometry args={[0.24, 0.48, 4]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} roughness={0.4} />
    </mesh>
  );
}

function Pad({ at, color, lit }: { at: Vec3; color: string; lit: boolean }) {
  return (
    <mesh position={[at[0], at[1] + 0.03, at[2]]} raycast={noRaycast}>
      <cylinderGeometry args={[PAD, PAD, 0.06, 32]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={lit ? 0.45 : 0} transparent opacity={lit ? 0.95 : 0.6} />
    </mesh>
  );
}

/** A ring pulsing around a broken sabotage's panel. */
function Alarm({ at, color }: { at: Vec3; color: string }) {
  const mesh = useRef<Mesh>(null);
  useFrame(({ clock: time }) => {
    const ring = mesh.current;
    if (!ring) return;
    const pulse = 1 + 0.18 * Math.sin(time.elapsedTime * 6);
    ring.scale.set(pulse, 1, pulse);
  });
  return (
    <mesh ref={mesh} position={[at[0], at[1] + 0.08, at[2]]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
      <ringGeometry args={[PAD + 0.1, PAD + 0.35, 40]} />
      <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.9} transparent opacity={0.85} />
    </mesh>
  );
}

/** A floor grate: a dark plate with three bars. */
function Vent({ at, color }: { at: Vec3; color: string }) {
  return (
    <group position={[at[0], at[1] + 0.04, at[2]]}>
      <mesh raycast={noRaycast}>
        <boxGeometry args={[1.1, 0.06, 0.8]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
      {[-0.25, 0, 0.25].map((z) => (
        <mesh key={z} position={[0, 0.04, z]} raycast={noRaycast}>
          <boxGeometry args={[0.95, 0.03, 0.08]} />
          <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} />
        </mesh>
      ))}
    </group>
  );
}

/** The meeting table: a round top on a post, glowing while a meeting is on. */
function Table({ at, color, glow }: { at: Vec3; color: string; glow: string | null }) {
  return (
    <group position={at}>
      <mesh position={[0, 0.38, 0]} raycast={noRaycast}>
        <cylinderGeometry args={[0.12, 0.2, 0.76, 12]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, 0.8, 0]} raycast={noRaycast}>
        <cylinderGeometry args={[0.95, 0.95, 0.08, 40]} />
        <meshStandardMaterial color={color} emissive={glow ?? color} emissiveIntensity={glow ? 0.5 : 0} roughness={0.6} />
      </mesh>
    </group>
  );
}

/** Someone lying where they fell. */
function Body({ at, color }: { at: Vec3; color: string }) {
  return (
    <mesh position={[at[0], at[1] + 0.22, at[2]]} rotation={[0, 0, Math.PI / 2]} raycast={noRaycast}>
      <capsuleGeometry args={[0.22, 0.7, 4, 12]} />
      <meshStandardMaterial color={color} roughness={0.6} />
    </mesh>
  );
}

/** A bot: a round body with a visor and a pack, walking its route, its name over it. Ghosts are see-through. */
function Crewmate({ bot, colors, serverNow }: { bot: ImpostorBot; colors: Colors; serverNow: () => number }) {
  const group = useRef<Group>(null);
  const facing = useRef(0);
  const color = colors.crew[bot.color % CREW_COLORS] ?? colors.body;
  const see = bot.ghost ? { transparent: true, opacity: 0.45 } : {};
  useFrame(({ clock: time }) => {
    const self = group.current;
    if (!self) return;
    const [x, y, z] = routeAt(bot.route, serverNow());
    const [dx, dz] = [x - self.position.x, z - self.position.z];
    const moving = dx * dx + dz * dz > 1e-5;
    if (moving) facing.current = Math.atan2(dx, dz);
    self.position.set(x, y + (moving ? Math.abs(Math.sin(time.elapsedTime * 9)) * 0.06 : 0), z);
    self.rotation.y = facing.current;
  });
  return (
    <group ref={group}>
      <mesh position={[0, 0.85, 0]} raycast={noRaycast}>
        <capsuleGeometry args={[0.4, 0.55, 6, 16]} />
        <meshStandardMaterial color={color} roughness={0.55} {...see} />
      </mesh>
      {[-0.18, 0.18].map((x) => (
        <mesh key={x} position={[x, 0.2, 0]} raycast={noRaycast}>
          <cylinderGeometry args={[0.15, 0.15, 0.4, 12]} />
          <meshStandardMaterial color={color} roughness={0.55} {...see} />
        </mesh>
      ))}
      <mesh position={[0, 1.08, 0.33]} scale={[1, 0.62, 0.55]} raycast={noRaycast}>
        <sphereGeometry args={[0.27, 20, 12]} />
        <meshStandardMaterial color={colors.visor} roughness={0.2} metalness={0.1} {...see} />
      </mesh>
      <mesh position={[0, 0.85, -0.42]} raycast={noRaycast}>
        <boxGeometry args={[0.5, 0.55, 0.22]} />
        <meshStandardMaterial color={color} roughness={0.6} {...see} />
      </mesh>
      <Html position={[0, 1.95, 0]} center zIndexRange={NAME_LAYERS} className="mg-impostor-name" pointerEvents="none">
        {bot.name}
      </Html>
    </group>
  );
}

/** The stations (the viewer's unfinished ones lit and marked), vents, the broken panel, the table, the bodies and the bots. */
export function ImpostorWorld(props: GameProps<ImpostorView>) {
  useImpostorSync(props);
  const { view, serverNow } = props;
  const colors = useMemo<Colors>(
    () => ({
      pad: token('--mg-impostor-pad'),
      task: token('--mg-impostor-task'),
      table: token('--mg-impostor-table'),
      body: token('--mg-impostor-body'),
      vent: token('--mg-impostor-vent'),
      alarm: token('--mg-impostor-alarm'),
      visor: token('--mg-impostor-visor'),
      crew: Array.from({ length: CREW_COLORS }, (_, index) => token(`--mg-crew-${index}`)),
    }),
    [],
  );
  // The crew lose their task list while the comms are down.
  const lost = view.progress === null && view.role === 'crew';
  const mine = new Set(view.phase === 'ended' || lost ? [] : view.tasks.filter((task) => !task.done).map((task) => task.station));
  const broken = !view.sabotage
    ? []
    : view.sabotage.kind === 'reactor'
      ? view.panels.reactor
      : [view.sabotage.kind === 'lights' ? view.panels.lights : view.panels.comms];
  // Bodies lie on the island's ground, where the table stands.
  const ground = view.table[1];
  return (
    <group>
      {view.stations.map((at, index) => (
        <group key={index}>
          <Pad at={at} color={mine.has(index) ? colors.task : colors.pad} lit={mine.has(index)} />
          {mine.has(index) && <Marker at={at} color={colors.task} />}
          {broken.includes(index) && <Alarm at={at} color={colors.alarm} />}
        </group>
      ))}
      {view.vents.map((at, index) => (
        <Vent key={index} at={at} color={colors.vent} />
      ))}
      <Table at={view.table} color={colors.table} glow={view.meeting ? colors.task : null} />
      {view.bodies.map((body) => (
        <Body
          key={body.id}
          at={[body.position[0], ground, body.position[2]]}
          color={body.color === null ? colors.body : (colors.crew[body.color % CREW_COLORS] ?? colors.body)}
        />
      ))}
      {view.bots.map((bot) => (
        <Crewmate key={bot.id} bot={bot} colors={colors} serverNow={serverNow} />
      ))}
    </group>
  );
}
