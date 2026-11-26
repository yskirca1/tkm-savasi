// End-to-end match with the real simulation (virtual clock).
import { describe, expect, it } from 'vitest';
import { SPECIES, VOTE_OPEN_SEC } from '@tkm/shared';
import { sim } from '../sim/index.js';
import { setup, USERS } from './testkit.js';

describe('full match with the real sim', () => {
  it('plays 3 rounds (2 humans + bot) to matchEnd and saves results', () => {
    const env = setup({ sim, unitsPerType: 6, seed: 99 });
    const { code } = env.mgr.createRoom(USERS.a, 3);
    env.mgr.joinRoom(USERS.b, code);
    const room = env.mgr.getRoom(code)!;
    room.startWithBot(USERS.a.userId);

    let guard = 0;
    while (room.phase !== 'matchEnd' && guard++ < 20_000) {
      if (room.phase === 'picking') {
        const ps = room.pickState()!;
        const seat = room.seats[ps.currentSeat!];
        if (seat.kind === 'human') room.choose(seat.userId!, SPECIES.find((s) => !room.picks.includes(s))!);
      }
      if (room.phase === 'playing' && room.elapsedMs / 1000 >= VOTE_OPEN_SEC) {
        room.vote(USERS.a.userId, true);
        room.vote(USERS.b.userId, true);
      }
      env.sched.advance(100);
    }
    expect(room.phase).toBe('matchEnd');
    expect(env.transport.of('round:end')).toHaveLength(3);
    const snap = env.transport.last('game:snapshot')!;
    expect(snap.units.length % 3).toBe(0);
    expect(env.saved).toHaveLength(1);
    expect(env.saved[0].results.map((r) => r.userId).sort()).toEqual([USERS.a.userId, USERS.b.userId].sort());
    const me = env.transport.last('match:end')!;
    expect(me.scores.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(3);
  });
});
