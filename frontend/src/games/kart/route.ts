import type { Vec3 } from '../protocol';
import type { KartRoute } from './index';

/** Where a bot on `route` is at `now` (server clock): as the server reckons it (server/src/games/kart/bots.rs). */
export function routeAt({ points, departAt, speed }: KartRoute, now: number): Vec3 {
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

/** `m:ss.cc`, a race time. */
export function raceTime(ms: number): string {
  const hundredths = Math.floor(ms / 10);
  const minutes = Math.floor(hundredths / 6000);
  const seconds = Math.floor((hundredths % 6000) / 100);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
}
