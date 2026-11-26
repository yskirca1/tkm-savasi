import { describe, expect, it } from 'vitest';
import type { SeatIndex, Species } from '@tkm/shared';
import { sim } from './index.js';

describe('pick rotation', () => {
  it('example [0,1,2]', () => {
    expect(sim.pickOrder([0, 1, 2], 0)).toEqual([0, 1, 2]);
    expect(sim.pickOrder([0, 1, 2], 1)).toEqual([1, 2, 0]);
    expect(sim.pickOrder([0, 1, 2], 2)).toEqual([2, 0, 1]);
  });
  it('random perms: each seat first exactly once per block; orders are permutations', () => {
    const rng = sim.createRng(99);
    for (let n = 0; n < 200; n++) {
      const perm = sim.randomSeatPerm(rng);
      expect([...perm].sort()).toEqual([0, 1, 2]);
      const firsts: number[] = [];
      for (let k = 0; k < 3; k++) {
        const o = sim.pickOrder(perm, k);
        expect([...o].sort()).toEqual([0, 1, 2]);
        firsts.push(o[0]);
      }
      expect(firsts.sort()).toEqual([0, 1, 2]);
    }
  });
  it('randomSeatPerm produces all 6 permutations', () => {
    const rng = sim.createRng(1);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(sim.randomSeatPerm(rng).join(''));
    expect(seen.size).toBe(6);
  });
});

describe('rng', () => {
  it('deterministic, in [0,1)', () => {
    const a = sim.createRng(5);
    const b = sim.createRng(5);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('vote', () => {
  const seatSpecies: [Species, Species, Species] = ['rock', 'paper', 'scissors'];
  const all = new Set<SeatIndex>([0, 1, 2]);
  it('closed before 90 s', () => {
    const v = sim.evaluateVote({ elapsedSec: 89.9, seatSpecies, counts: [5, 5, 5], approvals: all });
    expect(v.open).toBe(false);
    expect(v.allApproved).toBe(false);
    expect(sim.evaluateVote({ elapsedSec: 90, seatSpecies, counts: [5, 5, 5], approvals: all }).open).toBe(true);
  });
  it('all eligible approved -> allApproved; one missing -> false', () => {
    const v = sim.evaluateVote({ elapsedSec: 95, seatSpecies, counts: [5, 5, 5], approvals: all });
    expect(v.eligibleSeats).toEqual([0, 1, 2]);
    expect(v.approvedSeats).toEqual([0, 1, 2]);
    expect(v.allApproved).toBe(true);
    const w = sim.evaluateVote({ elapsedSec: 95, seatSpecies, counts: [5, 5, 5], approvals: new Set<SeatIndex>([0, 2]) });
    expect(w.approvedSeats).toEqual([0, 2]);
    expect(w.allApproved).toBe(false);
  });
  it('eliminated seat is not eligible and its approval is ignored', () => {
    // seat 1 (paper) eliminated
    const v = sim.evaluateVote({ elapsedSec: 120, seatSpecies, counts: [7, 0, 3], approvals: new Set<SeatIndex>([0, 2]) });
    expect(v.eligibleSeats).toEqual([0, 2]);
    expect(v.allApproved).toBe(true);
    const w = sim.evaluateVote({ elapsedSec: 120, seatSpecies, counts: [7, 0, 3], approvals: new Set<SeatIndex>([1, 2]) });
    expect(w.approvedSeats).toEqual([2]);
    expect(w.allApproved).toBe(false);
  });
  it('uses seat->species mapping', () => {
    const ss: [Species, Species, Species] = ['scissors', 'rock', 'paper'];
    const v = sim.evaluateVote({ elapsedSec: 100, seatSpecies: ss, counts: [4, 0, 0], approvals: new Set<SeatIndex>([1]) });
    expect(v.eligibleSeats).toEqual([1]);
    expect(v.allApproved).toBe(true);
  });
  it('voteWinner picks strict max, tie -> null', () => {
    expect(sim.voteWinner([10, 3, 2])).toBe('rock');
    expect(sim.voteWinner([1, 8, 2])).toBe('paper');
    expect(sim.voteWinner([1, 2, 9])).toBe('scissors');
    expect(sim.voteWinner([5, 5, 2])).toBeNull();
    expect(sim.voteWinner([4, 4, 4])).toBeNull();
    expect(sim.voteWinner([1, 6, 6])).toBeNull();
  });
});

describe('rankSeats', () => {
  it('dense ranking with ties', () => {
    expect(sim.rankSeats([3, 1, 2])).toEqual({ rank: [1, 3, 2], winners: [0] });
    expect(sim.rankSeats([3, 3, 1])).toEqual({ rank: [1, 1, 2], winners: [0, 1] });
    expect(sim.rankSeats([0, 2, 2])).toEqual({ rank: [2, 1, 1], winners: [1, 2] });
    expect(sim.rankSeats([2, 2, 2])).toEqual({ rank: [1, 1, 1], winners: [0, 1, 2] });
    expect(sim.rankSeats([1, 4, 1])).toEqual({ rank: [2, 1, 2], winners: [1] });
  });
});

describe('counts & drain', () => {
  it('speciesCounts and drainConverted', () => {
    const st = sim.createRound(3, 6);
    expect(sim.speciesCounts(st)).toEqual([6, 6, 6]);
    st.convertedSinceDrain.push(4, 7);
    expect(sim.drainConverted(st)).toEqual([4, 7]);
    expect(st.convertedSinceDrain).toEqual([]);
  });
});
