import type { Camera } from 'three';

// What the isometric camera frames: a point it looks at and how much of the world shows to either side of it and above
// and below. Going from one home to another, or out to the whole village, moves the frame; a drag across the picture
// turns the camera about that point, and the frame is then as much wider as the turned ground needs. The frame is
// fitted to what the page's panels leave open of the canvas, and the camera stands back as far as the lake that the
// rest of the canvas shows needs.

/** Where the camera looks from until it is turned: the south-east, a little above (its turn about y, its height above the ground). */
export const AZIMUTH = Math.PI / 4;
export const ELEVATION = (33 * Math.PI) / 180;

export type Frame = {
  /** The point at the middle of the view. */
  target: [number, number, number];
  /** Half the view's width and height, in the world's metres as the screen shows them. */
  halfWidth: number;
  halfHeight: number;
};

type Spot = { x: number; z: number };

/** How far a home reaches on screen from the middle of its island: to the sides, and up (tall trees) and down (its rock). */
const HOME_HALF_WIDTH = 8;
const HOME_HALF_HEIGHT = 7;
/** The view's middle is this far above the island's ground, between the treetops and the rock below. */
const EYE_HEIGHT = 1.5;

/** Where a spot on the ground falls on screen, in metres right and up of the world's origin. */
export function onScreen({ x, z }: Spot): { right: number; up: number } {
  const across = x * Math.cos(AZIMUTH) - z * Math.sin(AZIMUTH);
  const away = x * Math.sin(AZIMUTH) + z * Math.cos(AZIMUTH);
  return { right: across, up: -away * Math.sin(ELEVATION) };
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
 * not of the ground they cover, so a spot in a corner the others leave open on screen costs the frame nothing.
 */
export function frameOf(homes: readonly Spot[]): Frame {
  if (homes.length === 0) return { target: [0, EYE_HEIGHT, 0], halfWidth: HOME_HALF_WIDTH, halfHeight: HOME_HALF_HEIGHT };
  const spots = homes.map(onScreen);
  const rights = spots.map((spot) => spot.right);
  const ups = spots.map((spot) => spot.up);
  const centre = { right: (Math.min(...rights) + Math.max(...rights)) / 2, up: (Math.min(...ups) + Math.max(...ups)) / 2 };
  const middle = homes.length === 1 ? homes[0]! : onGround(centre);
  return {
    target: [middle.x, EYE_HEIGHT, middle.z],
    halfWidth: (Math.max(...rights) - Math.min(...rights)) / 2 + HOME_HALF_WIDTH,
    halfHeight: (Math.max(...ups) - Math.min(...ups)) / 2 + HOME_HALF_HEIGHT,
  };
}

/**
 * Half the view's width and height for the ground `frame` holds once the camera has turned `turn` radians about the
 * vertical from where the frame was measured: what lay across the picture now runs partly away from the camera, and
 * the other way about.
 */
export function turnedExtent(frame: Frame, turn: number): Pick<Frame, 'halfWidth' | 'halfHeight'> {
  const across = frame.halfWidth - HOME_HALF_WIDTH;
  const away = (frame.halfHeight - HOME_HALF_HEIGHT) / Math.sin(ELEVATION);
  const cos = Math.abs(Math.cos(turn));
  const sin = Math.abs(Math.sin(turn));
  return {
    halfWidth: HOME_HALF_WIDTH + across * cos + away * sin,
    halfHeight: HOME_HALF_HEIGHT + (across * sin + away * cos) * Math.sin(ELEVATION),
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
export const ZOOM_RANGE = { min: 0.6, max: 3.2 } as const;
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
  return Math.exp(pinch ? Math.min(notch, Math.max(-notch, -pixels * WHEEL_PINCH)) : -pixels * WHEEL_ZOOM);
}

/** How many pixels a metre takes for `frame` to fit a view `width` by `height` pixels. */
export function zoomOf(frame: Pick<Frame, 'halfWidth' | 'halfHeight'>, width: number, height: number): number {
  return Math.min(width / (2 * frame.halfWidth), height / (2 * frame.halfHeight));
}

/** How far from the point it looks at the camera stands, and how far past that point it draws, at the least. */
const CAMERA_DISTANCE = 120;
const CAMERA_BEYOND = 280;

/**
 * How much farther from the camera than the point it looks at the lake lies where the picture shows it `up` metres
 * above that point (nearer, and under it, when negative). `drop` is how far below the point the water is.
 */
export function waterDepth(up: number, drop: number): number {
  return up / Math.tan(ELEVATION) + drop / Math.sin(ELEVATION);
}

/**
 * How far from the point it looks at the camera stands, and how far from itself it draws (its far plane), for a canvas
 * `height` pixels tall that draws that point `shift` pixels below its own middle, at `zoom` pixels a metre. The picture
 * is the same from any distance, but only what lies between the camera's near plane (`near` metres in front of it) and
 * its far one is drawn: water outside them is left out, and the canvas shows the empty dark past a straight edge. A
 * window much taller than the frame fitted into it (a panel beside the picture in an upright window, a phone zoomed
 * out) shows the lake running on toward the viewer and away, so there the camera stands as far back, and draws as far,
 * as holds the water the canvas shows. Any other window is drawn from where the camera has always stood.
 */
export function cameraRange(height: number, shift: number, zoom: number, drop: number, near: number): { distance: number; far: number } {
  // The picture under the point and over it, in metres, to a pixel past the canvas's bottom and top.
  const below = (height / 2 - shift + 1) / zoom;
  const above = (height / 2 + shift + 1) / zoom;
  const distance = Math.max(CAMERA_DISTANCE, near - waterDepth(-below, drop));
  return { distance, far: distance + Math.max(CAMERA_BEYOND, waterDepth(above, drop)) };
}

/**
 * Stands `camera` `distance` metres from `target`, turned `azimuth` about the vertical and looking down at it. Its
 * matrices are brought up to date here, not left to the renderer: looking leaves them as the camera was turned the
 * frame before, and what is placed over the picture before it is drawn (the labels over the islands) is placed by them.
 */
export function stand(camera: Camera, target: readonly [number, number, number], azimuth: number, distance: number): void {
  const [x, y, z] = target;
  camera.position.set(
    x + Math.cos(ELEVATION) * Math.sin(azimuth) * distance,
    y + Math.sin(ELEVATION) * distance,
    z + Math.cos(ELEVATION) * Math.cos(azimuth) * distance,
  );
  camera.lookAt(x, y, z);
  camera.updateMatrixWorld();
}
