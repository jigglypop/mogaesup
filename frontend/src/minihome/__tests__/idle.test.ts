import { Matrix4, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { CAMERA_STILL, cameraMoved, isWorldInput } from '../IdleFrameRate';

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

describe('isWorldInput', () => {
  // The island's page: the canvas's element, and beside it the side panel with the chat's field.
  const world = document.createElement('div'), canvas = document.createElement('canvas');
  const panel = document.createElement('aside'), chat = document.createElement('input');
  world.append(canvas);
  panel.append(chat);
  document.body.append(world, panel);
  /** `event` as it arrives at the window after being sent to `target`. */
  const sent = (target: EventTarget, event: Event) => {
    target.dispatchEvent(event);
    return event;
  };
  const key = (type = 'keydown') => new KeyboardEvent(type, { key: 'w', bubbles: true });

  it('counts a pointer, wheel or touch on the world, and not one over the panel', () => {
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'touchstart', 'touchmove']) {
      expect(isWorldInput(sent(canvas, new Event(type, { bubbles: true })), world)).toBe(true);
      expect(isWorldInput(sent(panel, new Event(type, { bubbles: true })), world)).toBe(false);
    }
  });

  it('counts keys while the world or nothing has focus, and not a line typed into the chat', () => {
    expect(isWorldInput(sent(canvas, key()), world)).toBe(true);
    expect(isWorldInput(sent(document.body, key('keyup')), world)).toBe(true);
    // The engine's on-screen controls send their keys to the window itself.
    expect(isWorldInput(sent(window, key()), world)).toBe(true);
    expect(isWorldInput(sent(chat, key()), world)).toBe(false);
    expect(isWorldInput(sent(panel, key('keyup')), world)).toBe(false);
  });
});
