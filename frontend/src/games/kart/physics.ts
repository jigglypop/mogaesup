/**
 * The kart a page drives, arcade style: speed along a heading, steering that bites with speed, a drift that turns
 * tighter and slides, and a short boost for a drift held long enough. Pure: the page feeds it keys and time, and moves
 * the player's body at the velocity it gives.
 *
 * Heading 0 faces +z and a quarter turn faces +x (the body's yaw); steering right (positive) turns it clockwise seen
 * from above, which lowers it.
 */

export type KartInput = {
  /** 1 forward, −1 back or brake, 0 neither. */
  throttle: number;
  /** 1 right, −1 left. */
  steer: number;
  drift: boolean;
};

export type KartState = {
  /** Meters a second along the way it goes; negative backwards. */
  speed: number;
  heading: number;
  /** How far the way it goes is turned off its heading while it slides. */
  slip: number;
  drifting: boolean;
  /** Seconds this drift has lasted. */
  charge: number;
  /** Until when (ms, the page's clock) a drift's boost lasts. */
  turboUntil: number;
};

export type KartBoost = {
  /** The page's clock, ms. */
  now: number;
  /** An item booster or a boost pad: the fastest speed and a hard push. */
  boosted: boolean;
  /** Caught in a bubble, or held on the grid: stopped, no keys. */
  held: boolean;
};

export const KART = {
  /** Top speed on its own, backwards, with a drift's boost and with a booster or pad, in m/s. */
  top: 22,
  reverse: 7,
  turbo: 27,
  boost: 31,
  /** Speeding up, braking, rolling to a stop, and coming back down to the top speed after a boost, in m/s². */
  accel: 12,
  brake: 30,
  roll: 5,
  settle: 8,
  push: 40,
  /** How fast it turns at full lock, rad/s, and how much tighter a drift turns. */
  turn: 2.2,
  driftTurn: 1.5,
  /** Below this speed it turns less, and a drift does not start (and stops a little below it). */
  grip: 6,
  driftFrom: 10,
  /** How far a drift slides off the heading at full lock, and how fast the slide follows. */
  slip: 0.42,
  slipRate: 5,
  /** Speed a drift loses each second. */
  scrub: 2.5,
  /** A drift this long earns a boost this long, ms. */
  charge: 0.6,
  turboFor: 900,
} as const;

export const NEUTRAL: KartInput = { throttle: 0, steer: 0, drift: false };

export function startKart(heading: number): KartState {
  return { speed: 0, heading, slip: 0, drifting: false, charge: 0, turboUntil: 0 };
}

const toward = (value: number, target: number, step: number) =>
  value < target ? Math.min(target, value + step) : Math.max(target, value - step);

/** The kart `dt` seconds on. */
export function stepKart(state: KartState, input: KartInput, dt: number, { now, boosted, held }: KartBoost): KartState {
  if (held) return { ...state, speed: 0, slip: 0, drifting: false, charge: 0 };
  const steer = Math.max(-1, Math.min(1, input.steer));
  const throttle = Math.max(-1, Math.min(1, input.throttle));
  let { speed, slip, drifting, charge, turboUntil } = state;

  // Drifting: starts with the key down, a turn and speed; ends when the key comes up or the speed goes. One held long
  // enough boosts as it ends.
  if (!drifting && input.drift && steer !== 0 && speed >= KART.driftFrom) {
    drifting = true;
    charge = 0;
  } else if (drifting && (!input.drift || speed < KART.driftFrom * 0.7)) {
    if (charge >= KART.charge) turboUntil = now + KART.turboFor;
    drifting = false;
    charge = 0;
  }
  if (drifting) charge += dt;

  const turbo = now < turboUntil;
  if (boosted || turbo) {
    // A boost pushes on whatever the keys say.
    speed = toward(speed, boosted ? KART.boost : KART.turbo, KART.push * dt);
  } else if (speed > KART.top) {
    speed = Math.max(KART.top, speed - KART.settle * dt);
  } else if (throttle > 0) {
    speed = speed < 0 ? speed + KART.brake * dt : Math.min(KART.top, speed + KART.accel * throttle * dt);
  } else if (throttle < 0) {
    speed = speed > 0 ? Math.max(0, speed - KART.brake * dt) : Math.max(-KART.reverse, speed - KART.accel * 0.6 * dt);
  } else {
    speed = toward(speed, 0, KART.roll * dt);
  }
  if (drifting && speed > 0) speed = Math.max(0, speed - KART.scrub * dt);

  // Turning bites as it rolls, a little less at top speed, and the other way backwards.
  const pace = Math.abs(speed);
  const bite = Math.min(1, pace / KART.grip) * (1 - 0.25 * Math.min(1.2, pace / KART.top));
  const rate = KART.turn * bite * (drifting ? KART.driftTurn : 1) * Math.sign(speed);
  const heading = state.heading - steer * rate * dt;
  slip = toward(slip, drifting ? steer * KART.slip : 0, (drifting ? KART.slipRate : KART.slipRate * 1.4) * dt);
  return { speed, heading, slip, drifting, charge, turboUntil };
}

/** Its velocity on the ground, [x, z] in m/s: along its heading, turned by the slide. */
export function kartVelocity({ speed, heading, slip }: KartState): [number, number] {
  const way = heading + slip;
  return [Math.sin(way) * speed, Math.cos(way) * speed];
}

/**
 * The speed after the world had its say: `measured` is how fast the body really went the way the kart was going (a
 * barrier stops it, a scrape slows it). Small losses (damping, a bump) are not a crash.
 */
export function afterContact(speed: number, measured: number): number {
  if (speed > 0 && measured < speed * 0.8 - 0.5) return Math.max(0, measured);
  if (speed < 0 && measured > speed * 0.8 + 0.5) return Math.min(0, measured);
  return speed;
}

/** The keys a kart reads, by `KeyboardEvent.code`. */
export const KART_KEYS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['ShiftLeft', 'ShiftRight'],
  item: ['Space', 'ControlLeft', 'ControlRight'],
} as const;

const ALL_KEYS: ReadonlySet<string> = new Set(Object.values(KART_KEYS).flat());

export const isKartKey = (code: string) => ALL_KEYS.has(code);

/** What the held keys ask of the kart. */
export function readKeys(held: ReadonlySet<string>): KartInput {
  const any = (codes: readonly string[]) => codes.some((code) => held.has(code));
  return {
    throttle: (any(KART_KEYS.forward) ? 1 : 0) - (any(KART_KEYS.back) ? 1 : 0),
    steer: (any(KART_KEYS.right) ? 1 : 0) - (any(KART_KEYS.left) ? 1 : 0),
    drift: any(KART_KEYS.drift),
  };
}
