import type { NPCAction } from 'gaesup-world';

import type { BreedMotion, PetBody, Surroundings, Vec3 } from '../motor';

/** An NPC as the engine runs one, enough for the motor and the puppet: idle and moveTo, a route walked in a line. */
export class FakeBody implements PetBody {
  position: Vec3 = [0, 0, 0];
  yaw = 0;
  route: { target: Vec3; speed: number; clip: string } | null = null;
  idleClip = 'idle';
  acted: NPCAction[][] = [];
  gestures: string[] = [];
  faced: Vec3[] = [];
  placed: Vec3[] = [];

  pose() {
    return { position: [...this.position] as Vec3, yaw: this.yaw };
  }
  moving() {
    return this.route !== null;
  }
  act(actions: NPCAction[]) {
    this.acted.push(actions);
    for (const action of actions) this.apply(action);
  }
  apply(action: NPCAction) {
    if (action.type === 'idle') {
      this.route = null;
      if (action.animationId) this.idleClip = action.animationId;
    } else if (action.type === 'moveTo') {
      this.route = { target: [...action.target], speed: action.speed ?? 3, clip: action.animationId ?? 'walk' };
    }
  }
  gesture(clip: string) {
    this.gestures.push(clip);
  }
  face(target: Vec3) {
    this.faced.push([...target]);
  }
  place(at: Vec3, yaw: number) {
    this.placed.push([...at]);
    this.position = [...at];
    this.yaw = yaw;
    this.route = null;
  }
  /** Walks the route for `dt` seconds, as the engine's simulation does. */
  step(dt: number) {
    const route = this.route;
    if (!route) return;
    const dx = route.target[0] - this.position[0];
    const dz = route.target[2] - this.position[2];
    const distance = Math.hypot(dx, dz);
    const travel = route.speed * dt;
    if (distance > 1e-9) this.yaw = Math.atan2(dx, dz);
    if (travel >= distance) {
      this.position = [...route.target];
      this.route = null;
    } else {
      this.position = [this.position[0] + (dx / distance) * travel, route.target[1], this.position[2] + (dz / distance) * travel];
    }
  }
}

export const MOTION: BreedMotion = {
  clips: new Set(['idle', 'walk', 'run', 'bark', 'jump', 'sit', 'lie', 'sit_hold', 'lie_hold']),
  mouth: { ahead: 0.4, up: 0.45 },
};

export function surroundings(changes: Partial<Surroundings> = {}): Surroundings {
  return {
    owner: { position: [0, 1, 6], yaw: 0, speed: 0 },
    visitor: null,
    home: [0, 0, 0],
    energy: 0.8,
    night: false,
    ground: () => 0,
    walkable: (x, z) => Math.abs(x) < 26 && Math.abs(z) < 26,
    ...changes,
  };
}
