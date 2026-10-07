import type { GameplayAreaConfig, GameplayEventBlueprint, LightingProfile } from 'gaesup-world';
import type { BuildingSerializedState } from 'gaesup-world/building';

export type IslandId = 'forest' | 'city' | 'cafe' | 'park' | 'farm' | 'beach' | 'camp' | 'winter';

/** The light over an island: the canvas behind it, the sky and ground fill, the sun and the sky map PBR reflects. */
export type SkyPreset = {
  /** The canvas's clear colour, and `--mg-island-sky` around it. */
  background: string;
  hemisphere: { sky: string; ground: string; intensity: number };
  sun: { position: [number, number, number]; color: string; intensity: number };
  environment: { sky?: string; horizon?: string; ground?: string; intensity: number };
};

/** An indoor room: while the player stands in its box the light turns to `profile`, with `lamp` overhead. */
export type IslandRoom = {
  id: string;
  center: [number, number, number];
  size: [number, number, number];
  profile: LightingProfile;
  lamp?: { color: string; intensity: number; distance: number; height: number };
};

/**
 * A prop the island waits for (an id from scripts/props/manifest.json once it is made), and the objects standing in
 * for it until then, by object id.
 */
export type IslandSlot = { id: string; prop: string; objects: string[] };

export type IslandTemplate = {
  id: IslandId;
  label: string;
  /** The island as it starts; the same every call (no Math.random). */
  build: () => BuildingSerializedState;
  /** Trigger boxes the arrival notes listen for. */
  areas: GameplayAreaConfig[];
  rules: GameplayEventBlueprint[];
  rooms: IslandRoom[];
  sky: SkyPreset;
  /** Where residents stand when the owner turns their island into this one, (x, z) on open ground. */
  residentSpots: [number, number][];
  /** The chooser's card picture. */
  picture: string;
  slots: IslandSlot[];
};
