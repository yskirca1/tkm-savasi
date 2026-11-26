import { SPECIES_INDEX, SPEED_STEPS, VOTE_OPEN_SEC } from '@tkm/shared';
import type { SeatIndex, Species, SpeedMultiplier } from '@tkm/shared';

const BY_INDEX: Species[] = ['rock', 'paper', 'scissors'];
type Trio = [SeatIndex, SeatIndex, SeatIndex];

export function speedAt(elapsedSec: number): SpeedMultiplier {
  let m: SpeedMultiplier = SPEED_STEPS[0].mult;
  for (const s of SPEED_STEPS) if (elapsedSec >= s.atSec) m = s.mult;
  return m;
}

export function pickOrder(blockPerm: Trio, roundInBlock: number): Trio {
  const k = ((Math.floor(roundInBlock) % 3) + 3) % 3;
  return [blockPerm[k], blockPerm[(k + 1) % 3], blockPerm[(k + 2) % 3]];
}

export function randomSeatPerm(rng: () => number): Trio {
  const p: SeatIndex[] = [0, 1, 2];
  for (let i = p.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  return [p[0], p[1], p[2]];
}

export function evaluateVote(args: {
  elapsedSec: number;
  seatSpecies: [Species, Species, Species];
  counts: [number, number, number];
  approvals: ReadonlySet<SeatIndex>;
}): { open: boolean; eligibleSeats: SeatIndex[]; approvedSeats: SeatIndex[]; allApproved: boolean } {
  const open = args.elapsedSec >= VOTE_OPEN_SEC;
  const eligibleSeats = ([0, 1, 2] as SeatIndex[]).filter(
    (s) => args.counts[SPECIES_INDEX[args.seatSpecies[s]]] > 0,
  );
  const approvedSeats = eligibleSeats.filter((s) => args.approvals.has(s));
  const allApproved = open && eligibleSeats.length > 0 && approvedSeats.length === eligibleSeats.length;
  return { open, eligibleSeats, approvedSeats, allApproved };
}

export function voteWinner(counts: [number, number, number]): Species | null {
  const max = Math.max(...counts);
  const idx = [0, 1, 2].filter((i) => counts[i] === max);
  return idx.length === 1 ? BY_INDEX[idx[0]] : null;
}

export function rankSeats(scores: [number, number, number]): {
  rank: [number, number, number];
  winners: SeatIndex[];
} {
  const distinct = [...new Set(scores)].sort((a, b) => b - a);
  const rank = scores.map((s) => distinct.indexOf(s) + 1) as [number, number, number];
  const max = distinct[0];
  const winners = ([0, 1, 2] as SeatIndex[]).filter((s) => scores[s] === max);
  return { rank, winners };
}
