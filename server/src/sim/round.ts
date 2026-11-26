import { GRID_CELL, OBSTACLES_ENABLED, SPECIES, SPECIES_INDEX, UNIT_RADIUS, UNIT_SPEED } from '@tkm/shared';
import type { MapData, Species } from '@tkm/shared';
import type { SimState, Unit } from './api.js';
import { blockedGrid, generateMap } from './map.js';
import { createRng, deriveSeed } from './rng.js';

const R = UNIT_RADIUS;
const CLEAR = R + 2; // min distance from obstacles / walls at spawn
const MIN_UNIT_DIST = 2 * R + 2;

function distToRect(x: number, y: number, o: { x: number; y: number; w: number; h: number }): number {
  const px = Math.max(o.x, Math.min(x, o.x + o.w));
  const py = Math.max(o.y, Math.min(y, o.y + o.h));
  const inside = x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h;
  return inside ? -1 : Math.hypot(x - px, y - py);
}

function positionOk(map: MapData, units: Unit[], x: number, y: number): boolean {
  if (x < CLEAR || y < CLEAR || x > map.width - CLEAR || y > map.height - CLEAR) return false;
  for (const o of map.obstacles) if (distToRect(x, y, o) < CLEAR) return false;
  for (const u of units) if (Math.hypot(u.x - x, u.y - y) < MIN_UNIT_DIST) return false;
  return true;
}

/**
 * Map a round is played on: the generated map when OBSTACLES_ENABLED, else the same world
 * with outer walls only (no obstacles).
 */
export function roundMap(seed: number, obstacles: boolean = OBSTACLES_ENABLED): MapData {
  const map = generateMap(seed);
  return obstacles ? map : { ...map, obstacles: [] };
}

/** SimApi.createRound: honors OBSTACLES_ENABLED. */
export function createRound(seed: number, unitsPerType: number): SimState {
  return createRoundWithMap(seed, unitsPerType, roundMap(seed));
}

/**
 * Internal: place units on a given map. Exported so tests can exercise obstacle maps
 * (e.g. `createRoundWithMap(seed, n, generateMap(seed))`) regardless of OBSTACLES_ENABLED.
 */
export function createRoundWithMap(seed: number, unitsPerType: number, map: MapData): SimState {
  const rng = createRng(deriveSeed(seed, 2));
  const units: Unit[] = [];
  const count = Math.max(0, Math.floor(unitsPerType));
  // interleave species so no species is systematically placed first
  const order: Species[] = [];
  for (let i = 0; i < count; i++) for (const s of SPECIES) order.push(s);

  const grid = blockedGrid(map);
  const cols = Math.floor(map.width / GRID_CELL);
  const rows = Math.floor(map.height / GRID_CELL);

  for (const species of order) {
    let x = NaN;
    let y = NaN;
    let ok = false;
    for (let attempt = 0; attempt < 500 && !ok; attempt++) {
      x = CLEAR + rng() * (map.width - 2 * CLEAR);
      y = CLEAR + rng() * (map.height - 2 * CLEAR);
      ok = positionOk(map, units, x, y);
    }
    if (!ok) {
      // fallback: scan free cell centers starting at a random cell
      const n = cols * rows;
      const start = Math.floor(rng() * n);
      for (let k = 0; k < n && !ok; k++) {
        const i = (start + k) % n;
        if (grid[i]) continue;
        x = ((i % cols) + 0.5) * GRID_CELL;
        y = (Math.floor(i / cols) + 0.5) * GRID_CELL;
        ok = positionOk(map, units, x, y);
      }
    }
    if (!ok) throw new Error(`sim: cannot place unit (seed ${seed})`);
    const ang = rng() * Math.PI * 2;
    units.push({ x, y, vx: Math.cos(ang) * UNIT_SPEED, vy: Math.sin(ang) * UNIT_SPEED, species });
  }
  return { seed, map, units, tick: 0, convertedSinceDrain: [] };
}

export function drainConverted(state: SimState): number[] {
  const out = state.convertedSinceDrain;
  state.convertedSinceDrain = [];
  return out;
}

export function packUnits(state: SimState): number[] {
  const out: number[] = new Array(state.units.length * 3);
  let k = 0;
  for (const u of state.units) {
    out[k++] = Math.round(u.x * 10) / 10;
    out[k++] = Math.round(u.y * 10) / 10;
    out[k++] = SPECIES_INDEX[u.species];
  }
  return out;
}
