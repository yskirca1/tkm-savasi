import type { SeatIndex, SeatKind } from '@tkm/shared';
import type { MatchResultInput } from '../db/types.js';

/** A human who held a seat when the match started. */
export interface Participant {
  userId: string;
  seat: SeatIndex;
  /** Rounds won while this human held the seat. */
  roundsWon: number;
  /** False once a bot replaced them (disconnect timeout or leave). */
  finishedInSeat: boolean;
}

export interface SeatOccupant {
  kind: SeatKind;
  userId: string | null;
}

/**
 * Per-human results for Store.saveMatch.
 * - A human is a winner iff they still hold their seat and that seat is among `winners` (ties share).
 * - Bot seats (incl. bots that replaced a human) never give anyone a win.
 */
export function computeMatchResults(
  seats: readonly SeatOccupant[],
  participants: Iterable<Participant>,
  winners: readonly SeatIndex[],
): MatchResultInput[] {
  const out: MatchResultInput[] = [];
  for (const p of participants) {
    const seat = seats[p.seat];
    const stillSeated = p.finishedInSeat && seat?.kind === 'human' && seat.userId === p.userId;
    out.push({
      userId: p.userId,
      roundsWon: p.roundsWon,
      isWinner: stillSeated && winners.includes(p.seat),
      finishedInSeat: stillSeated,
    });
  }
  return out;
}
