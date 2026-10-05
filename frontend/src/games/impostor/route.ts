import type { Vec3 } from '../protocol';
import type { BotRoute } from './index';

/** Where a bot on `route` is at `now` (server clock): as the server reckons it (server/src/games/impostor/walk.rs). */
export function routeAt({ points, departAt, speed }: BotRoute, now: number): Vec3 {
  let left = (Math.max(0, now - departAt) / 1000) * speed;
  for (let index = 1; index < points.length; index++) {
    const [from, to] = [points[index - 1]!, points[index]!];
    const step = Math.hypot(to[0] - from[0], to[2] - from[2]);
    if (left < step) {
      const share = step > 0 ? left / step : 0;
      return [from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share, from[2] + (to[2] - from[2]) * share];
    }
    left -= step;
  }
  return points.at(-1) ?? [0, 0, 0];
}
