import { describe, expect, it } from 'vitest';
import { computeMatchResults, type Participant } from './results.js';

const P = (userId: string, seat: 0 | 1 | 2, roundsWon: number, finishedInSeat = true): Participant => ({
  userId,
  seat,
  roundsWon,
  finishedInSeat,
});

describe('computeMatchResults', () => {
  it('ties share the win', () => {
    const seats = [
      { kind: 'human' as const, userId: 'a' },
      { kind: 'human' as const, userId: 'b' },
      { kind: 'human' as const, userId: 'c' },
    ];
    const r = computeMatchResults(seats, [P('a', 0, 2), P('b', 1, 2), P('c', 2, 1)], [0, 1]);
    expect(r.map((x) => x.isWinner)).toEqual([true, true, false]);
  });

  it('human tied with a bot still wins; bot alone → no human win', () => {
    const seats = [
      { kind: 'human' as const, userId: 'a' },
      { kind: 'human' as const, userId: 'b' },
      { kind: 'bot' as const, userId: null },
    ];
    expect(computeMatchResults(seats, [P('a', 0, 2), P('b', 1, 0)], [0, 2]).map((x) => x.isWinner)).toEqual([true, false]);
    expect(computeMatchResults(seats, [P('a', 0, 0), P('b', 1, 0)], [2]).map((x) => x.isWinner)).toEqual([false, false]);
  });

  it('replaced player gets finishedInSeat=false and no win even if the seat wins', () => {
    const seats = [
      { kind: 'human' as const, userId: 'a' },
      { kind: 'bot' as const, userId: null },
      { kind: 'human' as const, userId: 'c' },
    ];
    const r = computeMatchResults(seats, [P('a', 0, 0), P('b', 1, 2, false), P('c', 2, 0)], [1]);
    expect(r[1]).toEqual({ userId: 'b', roundsWon: 2, isWinner: false, finishedInSeat: false });
    expect(r[0].isWinner || r[2].isWinner).toBe(false);
  });
});
