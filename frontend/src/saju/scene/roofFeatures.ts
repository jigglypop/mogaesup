import type { Element } from '../elements';
import { roofOf, type House } from '../profile';
import { gableRoof, windowAt } from './arch';
import type { Builder, V3 } from './build';

// Height of the main ridge above the foundation in each of the five house plans.
const RIDGE: Record<Element, number> = { wood: 4.01, fire: 4.22, earth: 4.06, metal: 3.53, water: 4.17 };
const FINISH: Record<Element, string> = { wood: '#487362', fire: '#ab5941', earth: '#ae8953', metal: '#83959e', water: '#47738a' };
const FRAME = '#433c38';
const BRASS = '#c5a46a';
const SEAM = { metal: 0.55, rough: 0.48, sides: 8 };
const CLADDING = { metal: 0.32, rough: 0.58 };
const TAU = Math.PI * 2;

function twinGables(b: Builder, paint: string): void {
  // Two cross-gables meet the main roof at different heights. Their cheeks end inside the original slopes.
  for (const [x, width, rise] of [[-1.05, 1.35, 0.8], [0.88, 1.8, 1.3]] as const) {
    const depth = 2.36;
    b.box([width, 1.35, depth], [x, -0.5, 0.36], '#d6c3a3', { surface: 'plaster' });
    gableRoof(b, [x, 0.17, 0.36], {
      width: depth, depth: width, rise, over: 0.13, verge: 0.16, wall: '#ddccb1',
      trim: FRAME, cover: { kind: 'plain', color: paint }, ridge: paint, both: true,
    }, Math.PI / 2);
    for (const side of [-1, 1]) {
      const z = 0.36 + side * (depth / 2 + 0.015);
      windowAt(b, [x, 0.12 + rise * 0.11, z], { size: [width * 0.45, 0.58], frame: FRAME }, side === 1 ? 0 : Math.PI);
    }
  }
}

function glasshouse(b: Builder, paint: string): void {
  // The attic sits astride the ridge. The cheeks continue below its visible base down to the roof.
  b.box([3.25, 1.8, 1.3], [0.08, -0.025, 0], '#cbdacb', { surface: 'plaster' });
  for (const side of [-1, 1]) {
    windowAt(b, [0.08, 0.45, side * 0.655], { size: [3.08, 0.66], frame: paint, bars: [7, 1] }, side === 1 ? 0 : Math.PI);
    windowAt(b, [0.08 + side * 1.63, 0.45, 0], { size: [1.12, 0.66], frame: paint, bars: [3, 1] }, side * Math.PI / 2);
  }
  const run = 0.8;
  const rise = 0.53;
  const pitch = Math.atan2(rise, run);
  for (const side of [-1, 1]) {
    const z = side * run / 2;
    const turn: V3 = [side * pitch, 0, 0];
    b.box([3.55, 0.065, Math.hypot(rise, run)], [0.08, 0.88 + rise / 2, z], '#8eb5b4', { metal: 0.36, rough: 0.3 }, turn);
    for (let mullion = 0; mullion <= 7; mullion++) {
      b.box([0.036, 0.085, Math.hypot(rise, run)], [-1.67 + mullion * 0.5, 0.9 + rise / 2, z], paint, CLADDING, turn);
    }
  }
  b.prism([3.25, rise, 1.3], [0.08, 0.87, 0], '#a2c1bd', CLADDING);
  b.box([3.58, 0.1, 0.1], [0.08, 1.42, 0], paint, CLADDING);
}

function observatory(b: Builder, paint: string): void {
  // The drum is offset to the east, clear of the blue house's chimney in the west.
  b.group([0.52, 0, 0], () => {
    b.cyl(1.16, 1.82, [0, -0.09, 0], '#ddd0af', { surface: 'plaster', sides: 20 });
    for (const y of [0.17, 0.8]) b.cyl(1.23, 0.1, [0, y, 0], FRAME, { ...CLADDING, sides: 32 });
    for (let index = 0; index < 10; index++) {
      const turn = index * TAU / 10;
      windowAt(b, [Math.sin(turn) * 1.16, 0.49, Math.cos(turn) * 1.16], { size: [0.46, 0.4], bars: [1, 1], frame: FRAME }, turn);
    }
    b.dome([1.32, 1.23, 1.32], [0, 0.85, 0], paint, { ...CLADDING, detail: 28 });
    for (let rib = 0; rib < 8; rib++) {
      const turn = rib * TAU / 8;
      const line = Array.from({ length: 9 }, (_, index): V3 => {
        const angle = index * Math.PI / 16;
        const radius = Math.cos(angle) * 1.325;
        return [Math.sin(turn) * radius, 0.85 + Math.sin(angle) * 1.235, Math.cos(turn) * radius];
      });
      b.limb(line, [0.024], BRASS, SEAM);
    }
    b.ball(0.095, [0, 2.12, 0], BRASS, SEAM);
  });
}

function lanternTower(b: Builder, paint: string): void {
  b.group([0.65, 0, 0], () => {
    const octagon = Math.PI / 8;
    b.cyl(0.87, 2.12, [0, -0.01, 0], '#ead9bc', { top: 0.68, sides: 8, surface: 'plaster' }, octagon);
    for (const [height, radius] of [[0.32, 0.83], [0.97, 0.92], [1.89, 0.87]] as const) {
      b.cyl(radius, 0.13, [0, height, 0], paint, { ...CLADDING, sides: 8 }, octagon);
    }
    for (let wall = 0; wall < 8; wall++) {
      const turn = wall * TAU / 8;
      b.pane([0.55, 0.85], [0.67 * Math.sin(turn), 1.43, 0.67 * Math.cos(turn)], 'lantern', 1.7, turn);
      b.cyl(0.034, 0.95, [0.73 * Math.sin(turn + octagon), 1.43, 0.73 * Math.cos(turn + octagon)], FRAME, SEAM);
    }
    b.cone(1.06, 0.9, [0, 2.4, 0], paint, { ...CLADDING, sides: 8 }, octagon);
    b.ball(0.08, [0, 2.89, 0], BRASS, SEAM);
  });
}

/** A day master's roof, finished in the chart's second element. Every piece stays above the existing building lot. */
export function drawRoofFeature(b: Builder, house: House): void {
  const paint = FINISH[house.accent ?? house.style];
  b.group([0, RIDGE[house.style], 0], () => {
    switch (roofOf(house)) {
      case 'gables': return twinGables(b, paint);
      case 'glasshouse': return glasshouse(b, paint);
      case 'dome': return observatory(b, paint);
      case 'lantern': return lanternTower(b, paint);
      case 'ridge':
        b.box([3.52, 0.22, 0.32], [0, 0.2, 0], paint, { surface: 'clay' });
        for (const side of [-1, 1]) {
          b.limb([[side * 1.36, 0.25, 0], [side * 1.66, 0.31, 0], [side * 1.88, 0.49, 0], [side * 1.99, 0.7, 0]], [0.11, 0.105, 0.075, 0.025], paint, { sides: 10, surface: 'clay' });
        }
    }
  });
}
