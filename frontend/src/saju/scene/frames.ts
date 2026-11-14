// What the fixed isometric camera frames: a point it looks at and how much of the world shows to either side of it and
// above and below. The camera never turns; going from one home to another, or out to the whole village, moves the frame.

/** The camera looks from the south-east, a little above: its turn about y and its height above the ground. */
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

/** A frame holding every one of `homes`, centred on the middle of the ground they cover. */
export function frameOf(homes: readonly Spot[]): Frame {
  if (homes.length === 0) return { target: [0, EYE_HEIGHT, 0], halfWidth: HOME_HALF_WIDTH, halfHeight: HOME_HALF_HEIGHT };
  const xs = homes.map((home) => home.x);
  const zs = homes.map((home) => home.z);
  const middle = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
  const centre = onScreen(middle);
  const spots = homes.map(onScreen);
  return {
    target: [middle.x, EYE_HEIGHT, middle.z],
    halfWidth: Math.max(...spots.map((spot) => Math.abs(spot.right - centre.right))) + HOME_HALF_WIDTH,
    halfHeight: Math.max(...spots.map((spot) => Math.abs(spot.up - centre.up))) + HOME_HALF_HEIGHT,
  };
}

/** How many pixels a metre takes for `frame` to fit a view `width` by `height` pixels. */
export function zoomOf(frame: Frame, width: number, height: number): number {
  return Math.min(width / (2 * frame.halfWidth), height / (2 * frame.halfHeight));
}
