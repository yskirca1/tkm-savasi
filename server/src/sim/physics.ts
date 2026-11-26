import { BEATS, SPECIES_INDEX, TICK_MS, UNIT_RADIUS, UNIT_SPEED } from '@tkm/shared';
import type { MapData, Rect, Species, SpeedMultiplier } from '@tkm/shared';
import type { SimState, TickResult, Unit } from './api.js';

const R = UNIT_RADIUS;
const DT = TICK_MS / 1000;
const EPS = 1e-9;

/** Keep |v| === UNIT_SPEED. `fx,fy` is a fallback direction if v degenerated to ~0. */
function renormalize(u: Unit, fx = 1, fy = 0): void {
  let m = Math.hypot(u.vx, u.vy);
  if (m < 1e-6) {
    u.vx = fx;
    u.vy = fy;
    m = Math.hypot(fx, fy) || 1;
    if (m < 1e-6) {
      u.vx = 1;
      u.vy = 0;
      m = 1;
    }
  }
  u.vx = (u.vx / m) * UNIT_SPEED;
  u.vy = (u.vy / m) * UNIT_SPEED;
}

/** Reflect velocity about contact normal n (pointing out of the surface) if moving into it. */
function reflect(u: Unit, nx: number, ny: number): void {
  const vn = u.vx * nx + u.vy * ny;
  if (vn < 0) {
    u.vx -= 2 * vn * nx;
    u.vy -= 2 * vn * ny;
  }
}

/**
 * Penetration of the unit circle into a rect: returns {depth, nx, ny} with n pointing from
 * the rect toward the unit, or null if not overlapping.
 */
function rectContact(u: Unit, o: Rect): { depth: number; nx: number; ny: number } | null {
  const px = Math.max(o.x, Math.min(u.x, o.x + o.w));
  const py = Math.max(o.y, Math.min(u.y, o.y + o.h));
  const dx = u.x - px;
  const dy = u.y - py;
  const d2 = dx * dx + dy * dy;
  if (d2 > EPS) {
    if (d2 >= R * R) return null;
    const d = Math.sqrt(d2);
    return { depth: R - d, nx: dx / d, ny: dy / d };
  }
  // Center inside (or on the edge of) the rect: push out along the axis of least penetration.
  const left = u.x - o.x;
  const right = o.x + o.w - u.x;
  const top = u.y - o.y;
  const bottom = o.y + o.h - u.y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { depth: left + R, nx: -1, ny: 0 };
  if (m === right) return { depth: right + R, nx: 1, ny: 0 };
  if (m === top) return { depth: top + R, nx: 0, ny: -1 };
  return { depth: bottom + R, nx: 0, ny: 1 };
}

/** Push the unit out of outer walls and obstacles, reflecting velocity on contact. */
export function resolveStatic(u: Unit, map: MapData): void {
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    // outer walls
    if (u.x < R) { u.x = R; reflect(u, 1, 0); moved = true; }
    if (u.x > map.width - R) { u.x = map.width - R; reflect(u, -1, 0); moved = true; }
    if (u.y < R) { u.y = R; reflect(u, 0, 1); moved = true; }
    if (u.y > map.height - R) { u.y = map.height - R; reflect(u, 0, -1); moved = true; }
    // deepest obstacle contact first (avoids false corner normals at seams of adjacent rects)
    let best: { depth: number; nx: number; ny: number } | null = null;
    for (const o of map.obstacles) {
      const c = rectContact(u, o);
      if (c && (!best || c.depth > best.depth)) best = c;
    }
    if (best && best.depth > 1e-9) {
      u.x += best.nx * best.depth;
      u.y += best.ny * best.depth;
      reflect(u, best.nx, best.ny);
      moved = true;
    }
    if (!moved) break;
  }
}

function recordConversion(state: SimState, i: number): void {
  if (!state.convertedSinceDrain.includes(i)) state.convertedSinceDrain.push(i);
}

/** Unit-unit pass: conversions, elastic bounce (equal masses), overlap separation. */
function resolveUnits(state: SimState, allowConvert: boolean): void {
  const us = state.units;
  const n = us.length;
  const minD = 2 * R;
  for (let i = 0; i < n; i++) {
    const a = us[i];
    for (let j = i + 1; j < n; j++) {
      const b = us[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minD * minD) continue;
      const d = Math.sqrt(d2);
      if (d < 1e-9) {
        // exactly coincident: separate along a deterministic axis
        a.x -= R;
        b.x += R;
        continue;
      }
      const nx = dx / d;
      const ny = dy / d;
      if (allowConvert && a.species !== b.species) {
        if (BEATS[a.species] === b.species) {
          b.species = a.species;
          recordConversion(state, j);
        } else {
          a.species = b.species;
          recordConversion(state, i);
        }
      }
      // elastic bounce for equal masses: exchange normal velocity components if approaching
      const van = a.vx * nx + a.vy * ny;
      const vbn = b.vx * nx + b.vy * ny;
      if (van - vbn > 0) {
        a.vx += (vbn - van) * nx;
        a.vy += (vbn - van) * ny;
        b.vx += (van - vbn) * nx;
        b.vy += (van - vbn) * ny;
        renormalize(a, -nx, -ny);
        renormalize(b, nx, ny);
      }
      // separate overlap equally
      const push = (minD - d) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
    }
  }
}

export function subStep(state: SimState): void {
  const { units, map } = state;
  for (const u of units) {
    u.x += u.vx * DT;
    u.y += u.vy * DT;
    resolveStatic(u, map);
  }
  // first unit pass converts/bounces; extra passes only separate (positions), then always
  // re-resolve against walls/obstacles so a separation push can never leave a unit inside one.
  for (let pass = 0; pass < 3; pass++) {
    resolveUnits(state, pass === 0);
    for (const u of units) resolveStatic(u, map);
  }
  for (const u of units) renormalize(u);
}

export function speciesCounts(state: SimState): [number, number, number] {
  const c: [number, number, number] = [0, 0, 0];
  for (const u of state.units) c[SPECIES_INDEX[u.species]]++;
  return c;
}

const BY_INDEX: Species[] = ['rock', 'paper', 'scissors'];

export function tickSim(state: SimState, multiplier: SpeedMultiplier): TickResult {
  const steps = Math.max(1, Math.floor(multiplier));
  for (let s = 0; s < steps; s++) subStep(state);
  state.tick += 1;
  const counts = speciesCounts(state);
  const alive = [0, 1, 2].filter((k) => counts[k] > 0);
  const soleSurvivor = alive.length === 1 ? BY_INDEX[alive[0]] : null;
  return { counts, soleSurvivor };
}
