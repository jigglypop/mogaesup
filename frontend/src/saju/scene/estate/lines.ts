// Lines over the ground, for what runs across an estate rather than standing in one place: paths, the stream. A line
// is a list of points on the ground; it is smoothed into a gentle curve and measured from.

export type V2 = [number, number];

/** A line through `points`, smoothed (Catmull-Rom, through every point) and cut every `step` metres or less. */
export function smoothLine(points: readonly V2[], step = 0.4): V2[] {
  if (points.length < 2) return points.map(([x, z]) => [x, z]);
  const out: V2[] = [];
  for (let leg = 0; leg < points.length - 1; leg++) {
    const p0 = points[Math.max(0, leg - 1)]!;
    const p1 = points[leg]!;
    const p2 = points[leg + 1]!;
    const p3 = points[Math.min(points.length - 1, leg + 2)]!;
    const length = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const cuts = Math.max(1, Math.ceil(length / step));
    for (let cut = 0; cut < cuts; cut++) {
      const t = cut / cuts;
      const t2 = t * t;
      const t3 = t2 * t;
      const along = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([along(p0[0], p1[0], p2[0], p3[0]), along(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const last = points[points.length - 1]!;
  out.push([last[0], last[1]]);
  return out;
}

/** The length of a line. */
export function lengthOf(line: readonly V2[]): number {
  let length = 0;
  for (let index = 1; index < line.length; index++) length += Math.hypot(line[index]![0] - line[index - 1]![0], line[index]![1] - line[index - 1]![1]);
  return length;
}

/** The nearest point of a line to (x, z): how far it is, and how far along the line (0 at its start, 1 at its end). */
export function nearestOn(line: readonly V2[], x: number, z: number): { distance: number; along: number; at: V2 } {
  let best = Infinity;
  let bestAlong = 0;
  let bestAt: V2 = line[0] ?? [x, z];
  let walked = 0;
  const total = lengthOf(line) || 1;
  for (let index = 1; index < line.length; index++) {
    const [ax, az] = line[index - 1]!;
    const [bx, bz] = line[index]!;
    const dx = bx - ax;
    const dz = bz - az;
    const span = dx * dx + dz * dz;
    const t = span > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / span)) : 0;
    const px = ax + dx * t;
    const pz = az + dz * t;
    const distance = Math.hypot(x - px, z - pz);
    const piece = Math.sqrt(span);
    if (distance < best) {
      best = distance;
      bestAlong = (walked + piece * t) / total;
      bestAt = [px, pz];
    }
    walked += piece;
  }
  return { distance: best, along: bestAlong, at: bestAt };
}

/** The point `share` of the way along a line (0 its start, 1 its end), and the way the line runs there (radians, atan2 of z over x). */
export function pointAlong(line: readonly V2[], share: number): { at: V2; heading: number } {
  const total = lengthOf(line);
  let wanted = Math.min(1, Math.max(0, share)) * total;
  for (let index = 1; index < line.length; index++) {
    const [ax, az] = line[index - 1]!;
    const [bx, bz] = line[index]!;
    const piece = Math.hypot(bx - ax, bz - az);
    if (wanted <= piece || index === line.length - 1) {
      const t = piece > 0 ? Math.min(1, wanted / piece) : 0;
      return { at: [ax + (bx - ax) * t, az + (bz - az) * t], heading: Math.atan2(bz - az, bx - ax) };
    }
    wanted -= piece;
  }
  const only = line[0] ?? [0, 0];
  return { at: [only[0], only[1]], heading: 0 };
}

/** Where two lines first cross, walking the first: the point, and how far along each it lies (0 to 1). */
export function crossing(a: readonly V2[], b: readonly V2[]): { at: V2; alongA: number; alongB: number } | null {
  const totalA = lengthOf(a) || 1;
  const totalB = lengthOf(b) || 1;
  let walkedA = 0;
  for (let i = 1; i < a.length; i++) {
    const [p0x, p0z] = a[i - 1]!;
    const [p1x, p1z] = a[i]!;
    const pieceA = Math.hypot(p1x - p0x, p1z - p0z);
    let walkedB = 0;
    for (let j = 1; j < b.length; j++) {
      const [q0x, q0z] = b[j - 1]!;
      const [q1x, q1z] = b[j]!;
      const pieceB = Math.hypot(q1x - q0x, q1z - q0z);
      const rx = p1x - p0x;
      const rz = p1z - p0z;
      const sx = q1x - q0x;
      const sz = q1z - q0z;
      const denominator = rx * sz - rz * sx;
      if (Math.abs(denominator) > 1e-9) {
        const t = ((q0x - p0x) * sz - (q0z - p0z) * sx) / denominator;
        const u = ((q0x - p0x) * rz - (q0z - p0z) * rx) / denominator;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
          return { at: [p0x + rx * t, p0z + rz * t], alongA: (walkedA + pieceA * t) / totalA, alongB: (walkedB + pieceB * u) / totalB };
        }
      }
      walkedB += pieceB;
    }
    walkedA += pieceA;
  }
  return null;
}

/** A line's box on the ground, `margin` wider all round: what to test before measuring a point against it. */
export function boxOf(line: readonly V2[], margin = 0): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of line) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX: minX - margin, maxX: maxX + margin, minZ: minZ - margin, maxZ: maxZ + margin };
}
