import { describe, expect, it } from 'vitest';
import { GRID_CELL, TICK_MS, UNIT_RADIUS, UNIT_SPEED, WORLD_HEIGHT, WORLD_WIDTH } from '@tkm/shared';
import type { Species, SpeedMultiplier } from '@tkm/shared';
import { sim } from './index.js';
import type { SimState } from './index.js';
import { mkState, penetration } from './testutil.js';

const R = UNIT_RADIUS;
const S = UNIT_SPEED;

function headOn(a: Species, b: Species): SimState {
  return mkState([
    { x: 400, y: 300, vx: S, vy: 0, species: a },
    { x: 440, y: 300, vx: -S, vy: 0, species: b },
  ]);
}
function runUntilContactDone(st: SimState, ticks = 30): void {
  for (let i = 0; i < ticks; i++) sim.tickSim(st, 1);
}

describe('collision rules', () => {
  const cases: [Species, Species][] = [
    ['rock', 'scissors'],
    ['scissors', 'paper'],
    ['paper', 'rock'],
  ];
  for (const [winner, loser] of cases) {
    it(`${winner} beats ${loser} (either side)`, () => {
      for (const flip of [false, true]) {
        const st = flip ? headOn(loser, winner) : headOn(winner, loser);
        runUntilContactDone(st);
        expect(st.units.map((u) => u.species)).toEqual([winner, winner]);
        const loserIdx = flip ? 0 : 1;
        expect(sim.drainConverted(st)).toEqual([loserIdx]);
        expect(sim.drainConverted(st)).toEqual([]);
        // they bounced apart
        expect(st.units[0].vx).toBeLessThan(0);
        expect(st.units[1].vx).toBeGreaterThan(0);
        expect(Math.hypot(st.units[1].x - st.units[0].x, st.units[1].y - st.units[0].y)).toBeGreaterThanOrEqual(2 * R - 1e-6);
      }
    });
  }

  it('same species bounce: both survive, velocities reversed, speeds preserved', () => {
    for (const sp of ['rock', 'paper', 'scissors'] as Species[]) {
      const st = headOn(sp, sp);
      runUntilContactDone(st);
      expect(st.units.map((u) => u.species)).toEqual([sp, sp]);
      expect(st.convertedSinceDrain).toEqual([]);
      expect(st.units[0].vx).toBeCloseTo(-S, 6);
      expect(st.units[1].vx).toBeCloseTo(S, 6);
      for (const u of st.units) expect(Math.hypot(u.vx, u.vy)).toBeCloseTo(S, 6);
    }
  });

  it('oblique same-species collision keeps speeds and separates', () => {
    const st = mkState([
      { x: 400, y: 300, vx: S, vy: 0, species: 'rock' },
      { x: 430, y: 290, vx: 0, vy: S, species: 'rock' },
    ]);
    runUntilContactDone(st, 20);
    for (const u of st.units) expect(Math.hypot(u.vx, u.vy)).toBeCloseTo(S, 6);
    expect(Math.hypot(st.units[1].x - st.units[0].x, st.units[1].y - st.units[0].y)).toBeGreaterThanOrEqual(2 * R - 1e-6);
  });
});

describe('wall and obstacle bounce', () => {
  it('reflects off each outer wall and stays in bounds', () => {
    const dirs = [
      { x: 30, y: 300, vx: -S, vy: 0 },
      { x: WORLD_WIDTH - 30, y: 300, vx: S, vy: 0 },
      { x: 450, y: 30, vx: 0, vy: -S },
      { x: 450, y: WORLD_HEIGHT - 30, vx: 0, vy: S },
    ];
    for (const d of dirs) {
      const st = mkState([{ ...d, species: 'rock' }]);
      for (let i = 0; i < 30; i++) {
        sim.tickSim(st, 5);
        const u = st.units[0];
        expect(u.x).toBeGreaterThanOrEqual(R - 1e-9);
        expect(u.x).toBeLessThanOrEqual(WORLD_WIDTH - R + 1e-9);
        expect(u.y).toBeGreaterThanOrEqual(R - 1e-9);
        expect(u.y).toBeLessThanOrEqual(WORLD_HEIGHT - R + 1e-9);
      }
      const u = st.units[0];
      expect(u.vx).toBeCloseTo(-d.vx, 9);
      expect(u.vy).toBeCloseTo(-d.vy, 9);
      expect(Math.hypot(u.vx, u.vy)).toBeCloseTo(S, 9);
    }
  });

  it('reflects only the normal component at a 45° wall hit', () => {
    const v = S / Math.SQRT2;
    const st = mkState([{ x: 300, y: 25, vx: v, vy: -v, species: 'paper' }]);
    for (let i = 0; i < 10; i++) sim.tickSim(st, 1);
    expect(st.units[0].vx).toBeCloseTo(v, 9);
    expect(st.units[0].vy).toBeCloseTo(v, 9);
  });

  it('bounces off a flat obstacle face (single cell) at every speed', () => {
    const rect = { x: 300, y: 270, w: GRID_CELL, h: GRID_CELL };
    for (const m of [1, 2, 3, 5] as SpeedMultiplier[]) {
      const st = mkState([{ x: 250, y: 285, vx: S, vy: 0, species: 'rock' }], [rect]);
      // travel ~70 units: hits the face after ~39 and comes back ~30 (far from the left wall)
      const ticks = Math.ceil(70 / (3 * m));
      for (let i = 0; i < ticks; i++) {
        sim.tickSim(st, m);
        expect(penetration(st.units[0], rect)).toBeLessThanOrEqual(0.01);
      }
      expect(st.units[0].vx).toBeCloseTo(-S, 9);
      expect(st.units[0].x).toBeLessThan(300);
    }
  });

  it('corner hit reflects along the corner normal and leaves the obstacle', () => {
    const rect = { x: 300, y: 300, w: 60, h: 60 };
    const v = S / Math.SQRT2;
    // aimed exactly at the top-left corner along the diagonal -> comes straight back
    const st = mkState([{ x: 250, y: 250, vx: v, vy: v, species: 'rock' }], [rect]);
    for (let i = 0; i < 12; i++) {
      sim.tickSim(st, 3);
      expect(penetration(st.units[0], rect)).toBeLessThanOrEqual(0.01);
    }
    expect(st.units[0].vx).toBeCloseTo(-v, 6);
    expect(st.units[0].vy).toBeCloseTo(-v, 6);
  });

  it('a unit placed overlapping an obstacle is pushed out along the min-penetration normal', () => {
    const rect = { x: 300, y: 300, w: 90, h: 90 };
    const st = mkState([{ x: 305, y: 340, vx: S, vy: 0, species: 'rock' }], [rect]);
    sim.tickSim(st, 1);
    expect(penetration(st.units[0], rect)).toBeLessThanOrEqual(0.01);
    expect(st.units[0].x).toBeLessThan(300);
    expect(st.units[0].vx).toBeLessThan(0);
  });
});

describe('round end', () => {
  it('returns soleSurvivor when only one species remains', () => {
    const st = headOn('paper', 'rock');
    let res = sim.tickSim(st, 1);
    expect(res.soleSurvivor).toBeNull();
    expect(res.counts).toEqual([1, 1, 0]);
    for (let i = 0; i < 30 && !res.soleSurvivor; i++) res = sim.tickSim(st, 1);
    expect(res.soleSurvivor).toBe('paper');
    expect(res.counts).toEqual([0, 2, 0]);
  });

  it('tick counter increments by one per tick regardless of multiplier', () => {
    const st = sim.createRound(1, 4);
    sim.tickSim(st, 5);
    sim.tickSim(st, 1);
    expect(st.tick).toBe(2);
  });
});

describe('speed tiers', () => {
  it('speedAt thresholds', () => {
    const table: [number, number][] = [
      [0, 1], [29.99, 1], [30, 2], [44.99, 2], [45, 3], [59.99, 3], [60, 5], [500, 5],
    ];
    for (const [t, m] of table) expect(sim.speedAt(t)).toBe(m);
  });

  it('multiplier m moves m times as far per tick (open field)', () => {
    for (const m of [1, 2, 3, 5] as SpeedMultiplier[]) {
      const st = mkState([{ x: 100, y: 300, vx: S, vy: 0, species: 'rock' }]);
      sim.tickSim(st, m);
      expect(st.units[0].x - 100).toBeCloseTo((S * TICK_MS * m) / 1000, 9);
    }
  });
});

describe('no tunnelling / stability', () => {
  // plain comparisons (no expect() in the hot loop) — throws with context on the first violation
  function check(st: SimState, ctx: string): void {
    for (const u of st.units) {
      const out =
        u.x < R - 0.01 || u.y < R - 0.01 || u.x > st.map.width - R + 0.01 || u.y > st.map.height - R + 0.01;
      if (out) throw new Error(`${ctx}: unit outside world ${JSON.stringify(u)}`);
      if (Math.abs(Math.hypot(u.vx, u.vy) - S) > 1e-6) throw new Error(`${ctx}: bad speed ${JSON.stringify(u)}`);
      for (const o of st.map.obstacles) {
        const p = penetration(u, o);
        if (p > 0.01) throw new Error(`${ctx}: unit ${JSON.stringify(u)} overlaps ${JSON.stringify(o)} by ${p}`);
      }
    }
  }
  for (const m of [1, 5] as SpeedMultiplier[]) {
    it(`3000 ticks at ${m}x across many seeds: never inside obstacles or outside the world`, () => {
      for (let seed = 1; seed <= 25; seed++) {
        const st = sim.createRound(seed * 7919 + m, seed % 2 ? 12 : 20);
        check(st, `seed ${seed} start`);
        for (let t = 0; t < 3000; t++) {
          sim.tickSim(st, m);
          check(st, `seed ${seed} tick ${t}`);
        }
      }
    }, 120_000);
  }

  it('determinism: same seed gives identical trajectories', () => {
    const a = sim.createRound(4242, 12);
    const b = sim.createRound(4242, 12);
    for (let t = 0; t < 1500; t++) {
      const m = sim.speedAt((t * TICK_MS) / 1000);
      sim.tickSim(a, m);
      sim.tickSim(b, m);
    }
    expect(sim.packUnits(a)).toEqual(sim.packUnits(b));
    expect(a.units).toEqual(b.units);
  });
});
