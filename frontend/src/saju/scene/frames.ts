// What the isometric camera frames: a point it looks at and how much of the world shows to either side of it and above
// and below. Going from one home to another, or out to the whole village, moves the frame; a drag across the picture
// turns the camera about that point, and the frame is then as much wider as the turned ground needs.

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

/** How far in and out a viewer may zoom, as a multiple of the size at which the frame just fits. */
export const ZOOM_RANGE = { min: 0.6, max: 3.2 } as const;
export const clampZoom = (zoom: number) => Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, zoom));

/** How many pixels a metre takes for `frame` to fit a view `width` by `height` pixels. */
export function zoomOf(frame: Pick<Frame, 'halfWidth' | 'halfHeight'>, width: number, height: number): number {
  return Math.min(width / (2 * frame.halfWidth), height / (2 * frame.halfHeight));
}
