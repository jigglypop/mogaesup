import type { LightingProfile } from 'gaesup-world';

import type { IslandRoom, SkyPreset } from './types';

/** Daylight over grass: the light every island had before there were kinds of island. */
export const DAY: SkyPreset = {
  background: '#8fd3ee',
  hemisphere: { sky: '#eaf6ff', ground: '#6f8a57', intensity: 1.22 },
  sun: { position: [18, 36, 22], color: '#fff3da', intensity: 2.55 },
  environment: { intensity: 0.32 },
};

/** A paler, cooler sky over stone and paving. */
export const CITY: SkyPreset = {
  background: '#a9cbe3',
  hemisphere: { sky: '#eef3f8', ground: '#8b8f96', intensity: 1.18 },
  sun: { position: [22, 34, 18], color: '#fff6e6', intensity: 2.45 },
  environment: { sky: '#9fc3e0', horizon: '#e6eef4', ground: '#8b8f96', intensity: 0.36 },
};

/** A low, warm afternoon sun. */
export const GOLDEN: SkyPreset = {
  background: '#f6d7b0',
  hemisphere: { sky: '#fff0dc', ground: '#8a7652', intensity: 1.12 },
  sun: { position: [30, 20, 14], color: '#ffcf8f', intensity: 2.3 },
  environment: { sky: '#f3c99a', horizon: '#ffe9cc', ground: '#8a7652', intensity: 0.3 },
};

/** Bright sky over sand and shallow water. */
export const BEACH: SkyPreset = {
  background: '#74cdee',
  hemisphere: { sky: '#f4fbff', ground: '#d8c79c', intensity: 1.3 },
  sun: { position: [16, 40, 24], color: '#fff8e8', intensity: 2.7 },
  environment: { sky: '#5ec0ea', horizon: '#dff4fb', ground: '#d8c79c', intensity: 0.36 },
};

/** A white winter sky with snow throwing light back up. */
export const SNOW: SkyPreset = {
  background: '#d6e6f3',
  hemisphere: { sky: '#f5f9ff', ground: '#c9d3de', intensity: 1.28 },
  sun: { position: [20, 30, 26], color: '#edf3ff', intensity: 2.0 },
  environment: { sky: '#c6daec', horizon: '#f2f7fc', ground: '#dfe7ef', intensity: 0.4 },
};

/** Inside a room most daylight stays out; a warm fill and the ceiling lamp light it. */
export const ROOM_LIGHT: LightingProfile = { sun: 0.3, fill: 0.72, sky: '#ffe8d2', ground: '#8a6d58', environment: 0.45 };
export const ROOM_LAMP: NonNullable<IslandRoom['lamp']> = { color: '#ffcf8f', intensity: 9, distance: 10, height: 3 };
