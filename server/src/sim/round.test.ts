import { describe, expect, it } from 'vitest';
import { TICK_MS } from '@tkm/shared';
import { sim } from './index.js';

describe('full round smoke test', () => {
  it('12 per type: rounds end with a sole survivor within a bounded number of ticks', () => {
    const MAX_TICKS = 30 * 60 * 20; // 20 minutes of game time
    const lengths: number[] = [];
    let unfinished = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const st = sim.createRound(seed * 104729, 12);
      let done = false;
      for (let t = 0; t < MAX_TICKS; t++) {
        const res = sim.tickSim(st, sim.speedAt((t * TICK_MS) / 1000));
        const c = res.counts;
        expect(c[0] + c[1] + c[2]).toBe(36);
        if (res.soleSurvivor) {
          expect(c.filter((x) => x > 0).length).toBe(1);
          lengths.push(((t + 1) * TICK_MS) / 1000);
          done = true;
          break;
        }
      }
      if (!done) unfinished++;
    }
    lengths.sort((a, b) => a - b);
    const med = lengths[Math.floor(lengths.length / 2)];
    console.log(
      `[round] ended ${lengths.length}/20, unfinished ${unfinished}; seconds min ${lengths[0]?.toFixed(1)} median ${med?.toFixed(1)} max ${lengths[lengths.length - 1]?.toFixed(1)}; all: ${lengths.map((x) => x.toFixed(0)).join(',')}`,
    );
    expect(lengths.length).toBeGreaterThanOrEqual(15);
  }, 300_000);
});
