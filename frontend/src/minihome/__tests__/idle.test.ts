import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { CAMERA_STILL, cameraMoved } from '../IdleFrameRate';

const pose = (yaw: number, x = 0) =>
  new Matrix4().compose(new Vector3(x, 10, -10), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw), new Vector3(1, 1, 1))
    .elements;

describe('cameraMoved', () => {
  it('ignores the last-bit flicker of a settled follow camera', () => {
    const settled = pose(0.4);
    const flicker = settled.map((value, index) => (index === 0 ? value + 1.1102230246251565e-16 : value));
    expect(cameraMoved(settled, flicker)).toBe(false);
  });

  it('sees a turn or a step well below what shows on screen', () => {
    expect(cameraMoved(pose(0.4), pose(0.4 + 1e-4))).toBe(true);
    expect(cameraMoved(pose(0.4), pose(0.4, 1e-4))).toBe(true);
  });

  it('compares against the pose it last saw, so a slow drift still counts once it adds up', () => {
    const seen = pose(0.4);
    const step = CAMERA_STILL / 2;
    expect(cameraMoved(seen, pose(0.4, step))).toBe(false);
    expect(cameraMoved(seen, pose(0.4, 4 * step))).toBe(true);
  });
});
