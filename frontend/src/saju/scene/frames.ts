import type { Camera } from 'three';

import { ISLANDS, type IslandKind } from './terrain';

// What the isometric camera frames: a point it looks at and how much of the world shows to either side of it and above
// and below. Going from one home to another, or out to the whole village, moves the frame; the viewer turns the camera
// about that point all the way round, tilts it between a low look across the water and one nearly straight down, and
// moves the point itself, and the frame is then as much wider or taller as the ground it holds needs from there. The
// frame is fitted to what the page's panels leave open of the canvas, and the camera stands back as far as the lake
// that the rest of the canvas shows needs.

/** Where the camera looks from until it is turned or tilted: the south-east, a little above (its turn about y, its height above the ground). */
export const AZIMUTH = Math.PI / 4;
export const ELEVATION = (33 * Math.PI) / 180;
/** How low and how high the viewer may tilt it: from a look across the water to one nearly straight down. */
export const TILT_RANGE = { min: (15 * Math.PI) / 180, max: (80 * Math.PI) / 180 } as const;
export const clampTilt = (tilt: number) => Math.min(TILT_RANGE.max, Math.max(TILT_RANGE.min, tilt));

export type Frame = {
  /** The point at the middle of the view. */
  target: [number, number, number];
  /** Half the view's width and height, in the world's metres as the screen shows them from where the camera stands untouched. */
  halfWidth: number;
  halfHeight: number;
  /**
   * How far the islands' middles spread from the target on the ground, across the untouched view and away from it, and
   * how far the largest of the islands reaches about its own middle: what the frame is worked out from again for a
   * camera that has been turned or tilted.
   */
  across: number;
  away: number;
  reach: number;
};

/** A place in the village: an island's middle on the ground, and whose island it is; `reach` for an island of its own size (a shared island's harbour). */
export type Spot = { x: number; z: number; kind?: IslandKind; reach?: number };

/** An island reaches this much further across the picture than its bank does: the shore's stones, a leaning tree. */
const SIDE_MARGIN = 0.6;
/**
 * Half of what stands above an island's ground and hangs below it (trees and a roof up, the rock of its bank down), in
 * metres: seen from the side it counts in full, from overhead not at all. A neighbour's island seen from the untouched
 * camera then reaches seven metres up and down the picture from the middle of the view.
 */
const STANDING = (7 - ISLANDS.neighbour.reach * Math.sin(ELEVATION)) / Math.cos(ELEVATION);
/** The view's middle is this far above the island's ground, between the treetops and the rock below. */
const EYE_HEIGHT = 1.5;

/** How far an island reaches from its middle on the ground: the page's own island, at the village's middle, is the larger. */
function reachOf({ x, z, kind, reach }: Spot): number {
  return reach ?? ISLANDS[kind ?? (x === 0 && z === 0 ? 'home' : 'neighbour')].reach;
}

/** How far an island that reaches `reach` metres spreads across the picture from its middle, to either side. */
const halfWidthOf = (reach: number) => reach + SIDE_MARGIN;
/** How far it spreads up and down the picture from the middle of the view, seen from `tilt` above the ground. */
const halfHeightOf = (reach: number, tilt: number) => reach * Math.sin(tilt) + STANDING * Math.cos(tilt);

/**
 * Where a spot on the ground falls on screen, in metres right and up of the world's origin, seen from the untouched
 * camera's side and `tilt` above the ground.
 */
export function onScreen({ x, z }: Spot, tilt = ELEVATION): { right: number; up: number } {
  const across = x * Math.cos(AZIMUTH) - z * Math.sin(AZIMUTH);
  const away = x * Math.sin(AZIMUTH) + z * Math.cos(AZIMUTH);
  return { right: across, up: -away * Math.sin(tilt) };
}

/** The spot on the ground that falls at `right` and `up` on screen: {@link onScreen} the other way. */
function onGround({ right, up }: { right: number; up: number }): Spot {
  const away = -up / Math.sin(ELEVATION);
  // A whole number of metres comes back as one, not a hair off it (and nothing as 0, not -0).
  const whole = (value: number) => Math.round(value * 1e9) / 1e9 + 0;
  return { x: whole(right * Math.cos(AZIMUTH) + away * Math.sin(AZIMUTH)), z: whole(away * Math.cos(AZIMUTH) - right * Math.sin(AZIMUTH)) };
}

/**
 * A frame holding every one of `homes`, centred on the middle of the picture they make: of where they fall on screen,
 * not of the ground they cover, so a spot in a corner the others leave open on screen costs the frame nothing. The
 * room given about the islands at its edges is that of the largest island that can come to an edge as the camera
 * turns: the page's own island, the larger, in the middle of a village of others never does.
 */
export function frameOf(homes: readonly Spot[]): Frame {
  if (homes.length === 0) {
    const reach = ISLANDS.neighbour.reach;
    return { target: [0, EYE_HEIGHT, 0], halfWidth: halfWidthOf(reach), halfHeight: halfHeightOf(reach, ELEVATION), across: 0, away: 0, reach };
  }
  const spots = homes.map((home) => onScreen(home));
  const rights = spots.map((spot) => spot.right);
  const ups = spots.map((spot) => spot.up);
  const centre = { right: (Math.min(...rights) + Math.max(...rights)) / 2, up: (Math.min(...ups) + Math.max(...ups)) / 2 };
  const middle = homes.length === 1 ? homes[0]! : onGround(centre);
  // However the camera turns, an island reaches no further from the middle than its own middle's distance and its reach.
  const apart = homes.map((home) => Math.hypot(home.x - middle.x, home.z - middle.z));
  const farthest = Math.max(...apart);
  const reach = Math.max(...homes.map((home, index) => reachOf(home) - (farthest - apart[index]!)));
  const across = (Math.max(...rights) - Math.min(...rights)) / 2;
  const away = (Math.max(...ups) - Math.min(...ups)) / 2 / Math.sin(ELEVATION);
  return {
    target: [middle.x, EYE_HEIGHT, middle.z],
    halfWidth: across + halfWidthOf(reach),
    halfHeight: away * Math.sin(ELEVATION) + halfHeightOf(reach, ELEVATION),
    across,
    away,
    reach,
  };
}

/**
 * Half the view's width and height for the ground `frame` holds once the camera has turned `turn` radians about the
 * vertical from where the frame was measured, and stands `tilt` above the ground: what lay across the picture now
 * runs partly away from the camera, and the other way about, and what runs away from it is foreshortened by the tilt.
 */
export function turnedExtent(frame: Pick<Frame, 'across' | 'away' | 'reach'>, turn: number, tilt = ELEVATION): Pick<Frame, 'halfWidth' | 'halfHeight'> {
  const cos = Math.abs(Math.cos(turn));
  const sin = Math.abs(Math.sin(turn));
  return {
    halfWidth: halfWidthOf(frame.reach) + frame.across * cos + frame.away * sin,
    halfHeight: halfHeightOf(frame.reach, tilt) + (frame.across * sin + frame.away * cos) * Math.sin(tilt),
  };
}

/** How much of the canvas lies under the page's own panels, in pixels from each edge: the picture is fitted to the rest. */
export type Inset = { top: number; right: number; bottom: number; left: number };
export const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

/** A strip of canvas narrower than this, in pixels, holds no picture. */
const OPEN_MIN = 64;

/**
 * The part of a canvas `width` by `height` pixels that `inset` leaves open: its size, and how far right of and below
 * the canvas's middle its own middle lies. Where the panels leave too little across or down to hold a picture (in a
 * window so small that its bars and its open panel meet, a pixel or less than none), the whole canvas counts that way:
 * the picture then shows through the panels at a size that can be seen, where a frame fitted to the strip is a speck.
 */
export function openArea(width: number, height: number, inset: Inset): { x: number; y: number; width: number; height: number } {
  const across = width - inset.left - inset.right;
  const down = height - inset.top - inset.bottom;
  const wide = across >= OPEN_MIN;
  const tall = down >= OPEN_MIN;
  return {
    x: wide ? (inset.left - inset.right) / 2 : 0,
    y: tall ? (inset.top - inset.bottom) / 2 : 0,
    width: Math.max(1, wide ? across : width),
    height: Math.max(1, tall ? down : height),
  };
}

/** How far in and out a viewer may zoom, as a multiple of the size at which the frame just fits. */
export const ZOOM_RANGE = { min: 0.5, max: 12 } as const;
export const clampZoom = (zoom: number) => Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, zoom));

/** How much a wheel's step zooms, per pixel it would have scrolled; a trackpad's pinch sends finer steps and counts for more. */
const WHEEL_ZOOM = 0.0016;
const WHEEL_PINCH = 0.012;
/** The pixels one notch of a mouse's wheel scrolls. */
const WHEEL_NOTCH = 100;

/**
 * What one step of the wheel multiplies the zoom by. `pixels` is how far it would have scrolled down; `pinch` says it
 * came with ctrl held, which is how a trackpad's pinch arrives. A mouse's wheel turned with ctrl held arrives the same
 * way, but a whole notch at a time: a step with ctrl zooms no further than that notch does without it.
 */
export function wheelZoom(pixels: number, pinch: boolean): number {
  const notch = WHEEL_NOTCH * WHEEL_ZOOM;
  // One event zooms a notch and a half at most: a wheel spun hard, or a mouse that sends a page's worth at once, would
  // otherwise jump the picture several times closer in a single step.
  const most = pinch ? notch : notch * 1.5;
  return Math.exp(Math.min(most, Math.max(-most, -pixels * (pinch ? WHEEL_PINCH : WHEEL_ZOOM))));
}

/** How many pixels a metre takes for `frame` to fit a view `width` by `height` pixels. */
export function zoomOf(frame: Pick<Frame, 'halfWidth' | 'halfHeight'>, width: number, height: number): number {
  return Math.min(width / (2 * frame.halfWidth), height / (2 * frame.halfHeight));
}

/**
 * How far the point the camera looks at moves over the ground for the picture to move `right` and `down` pixels with
 * the hand that drags it, at `zoom` pixels a metre, the camera turned to `azimuth` and standing `tilt` above the
 * ground: what was under the hand stays under it.
 */
export function dragShift(right: number, down: number, zoom: number, azimuth: number, tilt: number): Spot {
  const across = -right / zoom;
  // A metre of ground away from the camera rises on screen by the sine of the tilt.
  const away = down / zoom / Math.sin(tilt);
  return { x: across * Math.cos(azimuth) - away * Math.sin(azimuth), z: -across * Math.sin(azimuth) - away * Math.cos(azimuth) };
}

/**
 * How far the point the camera looks at (`target`) moves for a zoom from `before` to `after` to keep `under` (the
 * spot under the pointer, in the target's plane) where it is on screen: toward the pointer when zooming in.
 */
export function zoomShift(under: Spot, target: Spot, before: number, after: number): Spot {
  const share = 1 - before / after;
  return { x: (under.x - target.x) * share, z: (under.z - target.z) * share };
}

/** How far from the point it looks at the camera stands, and how far past that point it draws, at the least. */
const CAMERA_DISTANCE = 120;
const CAMERA_BEYOND = 280;

/**
 * How much farther from the camera than the point it looks at the lake lies where the picture shows it `up` metres
 * above that point (nearer, and under it, when negative), seen from `tilt` above the ground. `drop` is how far below
 * the point the water is.
 */
export function waterDepth(up: number, drop: number, tilt = ELEVATION): number {
  return up / Math.tan(tilt) + drop / Math.sin(tilt);
}

/**
 * How far from the point it looks at the camera stands, and how far from itself it draws (its far plane), for a canvas
 * `height` pixels tall that draws that point `shift` pixels below its own middle, at `zoom` pixels a metre, from `tilt`
 * above the ground. The picture is the same from any distance, but only what lies between the camera's near plane
 * (`near` metres in front of it) and its far one is drawn: water outside them is left out, and the canvas shows the
 * empty dark past a straight edge. A window much taller than the frame fitted into it (a panel beside the picture in an
 * upright window, a phone zoomed out), or a camera tilted low over the water, shows the lake running on toward the
 * viewer and away, so there the camera stands as far back, and draws as far, as holds the water the canvas shows. Any
 * other view is drawn from where the camera has always stood.
 */
export function cameraRange(height: number, shift: number, zoom: number, drop: number, near: number, tilt = ELEVATION): { distance: number; far: number } {
  // The picture under the point and over it, in metres, to a pixel past the canvas's bottom and top.
  const below = (height / 2 - shift + 1) / zoom;
  const above = (height / 2 + shift + 1) / zoom;
  const distance = Math.max(CAMERA_DISTANCE, near - waterDepth(-below, drop, tilt));
  return { distance, far: distance + Math.max(CAMERA_BEYOND, waterDepth(above, drop, tilt)) };
}

/**
 * Stands `camera` `distance` metres from `target`, turned `azimuth` about the vertical and `tilt` above the ground,
 * looking down at it. Its matrices are brought up to date here, not left to the renderer: looking leaves them as the
 * camera was turned the frame before, and what is placed over the picture before it is drawn (the labels over the
 * islands) is placed by them.
 */
export function stand(camera: Camera, target: readonly [number, number, number], azimuth: number, distance: number, tilt = ELEVATION): void {
  const [x, y, z] = target;
  camera.position.set(x + Math.cos(tilt) * Math.sin(azimuth) * distance, y + Math.sin(tilt) * distance, z + Math.cos(tilt) * Math.cos(azimuth) * distance);
  camera.lookAt(x, y, z);
  camera.updateMatrixWorld();
}
