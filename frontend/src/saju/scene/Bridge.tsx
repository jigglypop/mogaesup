import { useEffect, useMemo, useRef } from 'react';

import { AdditiveBlending, CanvasTexture, Color, MeshStandardMaterial, SpriteMaterial, type Group, type Mesh, type Sprite } from 'three';

import type { CompatTone } from '../compat';
import { ISLAND } from '../village';
import type { Lamp } from './build';
import { useLamps } from './Built';
import { BOX, Box, seeded } from './kit';
import { useAnimation } from './parts';
import { MOVING, Static } from './Static';

// 궁합 다리: the bridge of light over the water between the viewer's island and a neighbour's. An arch of planks that
// take the two homes' colours from end to end and glow with them, a light running along it, lanterns on its posts and
// lights crossing both ways.

const PLANKS = 15;
const ARCH = 0.72;
const WIDTH = 1.3;
/** Seconds between one plank appearing and the next, and how long each takes to settle. */
const PLANK_EVERY = 0.07;
const PLANK_SETTLE = 0.3;
const ORBS = 6;
/** Glints that come and go in the air over the bridge. */
const GLINTS = 9;
const TIMBER = '#8a6648';

/** What crosses the bridge, by what the two charts found in each other. */
const ORB_COLOR: Record<CompatTone, string> = { union: '#ffe27a', flow: '#ffffff', same: '#f3f6ff', spark: '#ffc08a' };
const ORB_SPEED: Record<CompatTone, number> = { union: 0.22, flow: 0.28, same: 0.18, spark: 0.4 };

let glow: CanvasTexture | null = null;
/** A soft round light, drawn once. */
function glowTexture(): CanvasTexture {
  if (glow) return glow;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  glow = new CanvasTexture(canvas);
  return glow;
}

/** Overshoots a little and settles: a plank dropping into place. */
const settle = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2);

/**
 * The bridge from the island at `from` to the one at `to` (their centres on the ground), in the two homes' colours. It
 * builds itself when it first appears: the planks one by one, then the rails and their lanterns.
 */
export function Bridge({ from, to, colors, tone }: { from: [number, number]; to: [number, number]; colors: [string, string]; tone: CompatTone }) {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  const length = Math.hypot(dx, dz) - ISLAND + 0.5;
  const planks = useRef<(Mesh | null)[]>([]);
  const rails = useRef<Group>(null);
  const orbs = useRef<(Sprite | null)[]>([]);
  const glints = useRef<(Sprite | null)[]>([]);
  const born = useRef<number | null>(null);
  const made = useMemo(() => {
    const [start, end] = [new Color(colors[0]), new Color(colors[1])];
    const timber = new Color(TIMBER);
    const deck = Array.from({ length: PLANKS }, (_, index) => {
      const color = start.clone().lerp(end, index / (PLANKS - 1));
      const material = new MeshStandardMaterial({ color: timber.clone().lerp(color, 0.45), roughness: 0.62 });
      material.emissive.copy(color);
      return material;
    });
    const light = new SpriteMaterial({ map: glowTexture(), color: new Color(ORB_COLOR[tone]).multiplyScalar(2.6), transparent: true, depthWrite: false, blending: AdditiveBlending });
    const halo = new SpriteMaterial({ map: glowTexture(), color: start.clone().lerp(end, 0.5).multiplyScalar(1.5), transparent: true, opacity: 0.4, depthWrite: false, blending: AdditiveBlending });
    return { deck, light, halo };
  }, [colors, tone]);
  useEffect(
    () => () => {
      for (const material of made.deck) material.dispose();
      made.light.dispose();
      made.halo.dispose();
    },
    [made],
  );
  const at = (t: number): [number, number, number] => [(t - 0.5) * length, ARCH * Math.sin(Math.PI * t) + 0.07, 0];
  const pitch = (t: number) => Math.atan((ARCH * Math.PI * Math.cos(Math.PI * t)) / length);
  const middle = useMemo(() => [(from[0] + to[0]) / 2, 0, (from[1] + to[1]) / 2] as const, [from, to]);
  const turn = Math.atan2(-dz, dx);
  // The bridge's own light on the banks it lands on, one lamp of each home's colour.
  const lamps = useMemo<Lamp[]>(() => {
    const reach = length * 0.3;
    return [
      { at: [-Math.cos(turn) * reach, 1.2, Math.sin(turn) * reach], color: colors[0], power: 2.2, reach: 5.5 },
      { at: [Math.cos(turn) * reach, 1.2, -Math.sin(turn) * reach], color: colors[1], power: 2.2, reach: 5.5 },
    ];
  }, [colors, length, turn]);
  useLamps(lamps, middle);
  useAnimation((time, still) => {
    born.current ??= time;
    const age = still ? Infinity : time - born.current;
    planks.current.forEach((plank, index) => {
      if (!plank) return;
      const shown = settle((age - index * PLANK_EVERY) / PLANK_SETTLE);
      plank.scale.set((length / PLANKS) * 0.9 * shown, 0.09 * shown, WIDTH * shown);
      plank.visible = shown > 0;
      // A light runs along the planks from the viewer's home to the neighbour's.
      const wave = Math.max(0, Math.sin(time * 2.2 - index * 0.5));
      made.deck[index]!.emissiveIntensity = 0.7 + wave ** 3 * 3.4;
    });
    const decked = age - (PLANKS * PLANK_EVERY + PLANK_SETTLE * 0.5);
    if (rails.current) {
      rails.current.visible = decked > 0;
      rails.current.scale.y = Math.max(0.0001, settle(decked / PLANK_SETTLE));
    }
    orbs.current.forEach((orb, index) => {
      if (!orb) return;
      const run = (time * ORB_SPEED[tone] + index / ORBS) % 1;
      const [x, y] = at(index % 2 ? 1 - run : run);
      orb.position.set(x, y + 0.7, (index % 2 ? -1 : 1) * (WIDTH / 2 - 0.05));
      orb.visible = decked > PLANK_SETTLE;
      orb.scale.setScalar(0.5 + Math.sin(run * Math.PI) * 0.4);
    });
    glints.current.forEach((glint, index) => {
      if (!glint) return;
      const life = (time * 0.5 + seeded(index + 40)) % 1;
      glint.visible = decked > PLANK_SETTLE;
      glint.scale.setScalar(Math.sin(life * Math.PI) ** 2 * 0.4);
    });
  });
  return (
    <group position={middle} rotation={[0, turn, 0]} userData={MOVING}>
      {made.deck.map((material, index) => {
        const t = (index + 0.5) / PLANKS;
        return <mesh key={index} ref={(mesh) => void (planks.current[index] = mesh)} geometry={BOX} material={material} position={at(t)} rotation={[0, 0, pitch(t)]} visible={false} castShadow receiveShadow />;
      })}
      <group ref={rails} visible={false}>
        <Static>
          {Array.from({ length: PLANKS }, (_, index) => {
            const t = (index + 0.5) / PLANKS;
            const post = index % 2 === 0;
            return (
              <group key={index} position={at(t)} rotation={[0, 0, pitch(t)]}>
                {[-1, 1].map((side) => (
                  <group key={side} position={[0, 0, side * (WIDTH / 2 - 0.05)]}>
                    {post && <Box size={[0.07, 0.6, 0.07]} position={[0, 0.3, 0]} color={TIMBER} />}
                    <Box size={[(length / PLANKS) * 1.06, 0.05, 0.06]} position={[0, 0.56, 0]} color={TIMBER} />
                    <Box size={[(length / PLANKS) * 1.06, 0.03, 0.03]} position={[0, 0.3, 0]} color={TIMBER} />
                    {post && index % 4 === 0 && <Box size={[0.11, 0.14, 0.11]} position={[0, 0.7, 0]} color="#fff3dc" emissive={colors[t < 0.5 ? 0 : 1]} glow={5} />}
                    {post && index % 4 === 0 && <Box size={[0.15, 0.03, 0.15]} position={[0, 0.79, 0]} color="#3a2e28" />}
                  </group>
                ))}
              </group>
            );
          })}
        </Static>
      </group>
      {Array.from({ length: ORBS }, (_, index) => (
        <sprite key={index} ref={(sprite) => void (orbs.current[index] = sprite)} material={made.light} visible={false} />
      ))}
      {Array.from({ length: GLINTS }, (_, index) => {
        const [x, y] = at(seeded(index + 7));
        return <sprite key={index} ref={(sprite) => void (glints.current[index] = sprite)} material={made.light} position={[x, y + 0.9 + seeded(index + 19) * 1.3, (seeded(index + 31) - 0.5) * WIDTH * 1.4]} visible={false} />;
      })}
      <sprite material={made.halo} position={[0, ARCH + 0.3, 0]} scale={[length * 1.7, 3.2, 1]} />
    </group>
  );
}
