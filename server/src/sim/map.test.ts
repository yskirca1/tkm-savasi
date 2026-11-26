import { describe, expect, it } from 'vitest';
import { GRID_CELL, OBSTACLES_ENABLED, UNIT_RADIUS, WORLD_HEIGHT, WORLD_WIDTH } from '@tkm/shared';
import { sim } from './index.js';
import { penetration } from './testutil.js';
import { createRoundWithMap } from './round.js';

/** Round on the full obstacle map (independent of OBSTACLES_ENABLED). */
const roundWithObstacles = (seed: number, n: number) => createRoundWithMap(seed, n, sim.generateMap(seed));

const COLS = WORLD_WIDTH / GRID_CELL;
const ROWS = WORLD_HEIGHT / GRID_CELL;

describe('map generation', () => {
  it('200 seeds: connected, cell-aligned, margin kept, sane blocked ratio', () => {
    let minR = 1;
    let maxR = 0;
    for (let seed = 0; seed < 200; seed++) {
      const map = sim.generateMap(seed * 2654435761);
      expect(map.width).toBe(WORLD_WIDTH);
      expect(map.height).toBe(WORLD_HEIGHT);
      expect(sim.isMapConnected(map)).toBe(true);
      let cells = 0;
      for (const o of map.obstacles) {
        for (const v of [o.x, o.y, o.w, o.h]) expect(v % GRID_CELL).toBe(0);
        expect(o.x).toBeGreaterThanOrEqual(GRID_CELL);
        expect(o.y).toBeGreaterThanOrEqual(GRID_CELL);
        expect(o.x + o.w).toBeLessThanOrEqual(WORLD_WIDTH - GRID_CELL);
        expect(o.y + o.h).toBeLessThanOrEqual(WORLD_HEIGHT - GRID_CELL);
        cells += (o.w / GRID_CELL) * (o.h / GRID_CELL);
      }
      const ratio = cells / (COLS * ROWS);
      minR = Math.min(minR, ratio);
      maxR = Math.max(maxR, ratio);
      expect(ratio).toBeGreaterThanOrEqual(0.06);
      expect(ratio).toBeLessThanOrEqual(0.16);
    }
    console.log(`[map] blocked ratio over 200 seeds: min ${(minR * 100).toFixed(1)}% max ${(maxR * 100).toFixed(1)}%`);
  });

  it('is deterministic per seed and varies across seeds', () => {
    expect(sim.generateMap(123)).toEqual(sim.generateMap(123));
    expect(sim.generateMap(123)).not.toEqual(sim.generateMap(124));
  });

  it('isMapConnected detects a sealed pocket', () => {
    const c = GRID_CELL;
    const map = {
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      obstacles: [
        { x: 3 * c, y: 3 * c, w: 3 * c, h: c },
        { x: 3 * c, y: 5 * c, w: 3 * c, h: c },
        { x: 3 * c, y: 4 * c, w: c, h: c },
        { x: 5 * c, y: 4 * c, w: c, h: c },
      ],
    };
    expect(sim.isMapConnected(map)).toBe(false);
    expect(sim.isMapConnected({ ...map, obstacles: map.obstacles.slice(0, 3) })).toBe(true);
  });
});

describe('createRound placement', () => {
  it('places units clear of obstacles, walls and each other; deterministic', () => {
    for (let seed = 0; seed < 50; seed++) {
      const st = roundWithObstacles(seed, 20);
      expect(st.map.obstacles.length).toBeGreaterThan(0);
      expect(st.units.length).toBe(60);
      expect(st.tick).toBe(0);
      expect(sim.speciesCounts(st)).toEqual([20, 20, 20]);
      for (const u of st.units) {
        expect(Math.hypot(u.vx, u.vy)).toBeCloseTo(90, 9);
        expect(u.x).toBeGreaterThanOrEqual(UNIT_RADIUS + 2);
        expect(u.y).toBeGreaterThanOrEqual(UNIT_RADIUS + 2);
        expect(u.x).toBeLessThanOrEqual(WORLD_WIDTH - UNIT_RADIUS - 2);
        expect(u.y).toBeLessThanOrEqual(WORLD_HEIGHT - UNIT_RADIUS - 2);
        for (const o of st.map.obstacles) expect(penetration({ ...u, x: u.x, y: u.y }, o)).toBe(0);
      }
      for (let i = 0; i < st.units.length; i++)
        for (let j = i + 1; j < st.units.length; j++) {
          const a = st.units[i];
          const b = st.units[j];
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * UNIT_RADIUS);
        }
    }
    expect(roundWithObstacles(77, 12)).toEqual(roundWithObstacles(77, 12));
  });

  it('OBSTACLES_ENABLED off: createRound has no obstacles; units inside the world, non-overlapping, deterministic', () => {
    expect(OBSTACLES_ENABLED).toBe(false);
    for (let seed = 0; seed < 50; seed++) {
      const st = sim.createRound(seed, 20);
      expect(st.map.obstacles).toEqual([]);
      expect(st.map.width).toBe(WORLD_WIDTH);
      expect(st.map.height).toBe(WORLD_HEIGHT);
      expect(sim.speciesCounts(st)).toEqual([20, 20, 20]);
      for (const u of st.units) {
        expect(u.x).toBeGreaterThanOrEqual(UNIT_RADIUS);
        expect(u.y).toBeGreaterThanOrEqual(UNIT_RADIUS);
        expect(u.x).toBeLessThanOrEqual(WORLD_WIDTH - UNIT_RADIUS);
        expect(u.y).toBeLessThanOrEqual(WORLD_HEIGHT - UNIT_RADIUS);
      }
      for (let i = 0; i < st.units.length; i++)
        for (let j = i + 1; j < st.units.length; j++) {
          const a = st.units[i];
          const b = st.units[j];
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * UNIT_RADIUS);
        }
    }
    expect(sim.createRound(77, 12)).toEqual(sim.createRound(77, 12));
    expect(sim.packUnits(sim.createRound(77, 12))).not.toEqual(sim.packUnits(sim.createRound(78, 12)));
  });

  it('packUnits rounds to 0.1 and encodes species index', () => {
    const st = sim.createRound(5, 4);
    const p = sim.packUnits(st);
    expect(p.length).toBe(36);
    for (let i = 0; i < st.units.length; i++) {
      expect(p[i * 3]).toBeCloseTo(st.units[i].x, 1);
      expect(Math.round(p[i * 3] * 10)).toBe(p[i * 3] * 10);
      expect([0, 1, 2]).toContain(p[i * 3 + 2]);
    }
  });
});
