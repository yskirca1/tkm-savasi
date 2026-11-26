import { describe, expect, it } from 'vitest';
import {
  BOT_NAME,
  BOT_THINK_MS,
  PICK_TIME_MS,
  RECONNECT_GRACE_MS,
  ROUND_END_DELAY_MS,
  ROUND_INTRO_MS,
  SPECIES,
  TICK_MS,
  type SeatIndex,
  type Species,
} from '@tkm/shared';
import type { Room } from './Room.js';
import { LOBBY_DISCONNECT_GRACE_MS } from './Room.js';
import { setup, USERS } from './testkit.js';
import { MSG } from '../errors.js';

type Env = ReturnType<typeof setup>;

function threeHumans(env: Env): Room {
  const { code } = env.mgr.createRoom(USERS.a);
  expect(env.mgr.joinRoom(USERS.b, code).ok).toBe(true);
  expect(env.mgr.joinRoom(USERS.c, code).ok).toBe(true);
  return env.mgr.getRoom(code)!;
}

function twoHumansAndBot(env: Env): Room {
  const { code } = env.mgr.createRoom(USERS.a);
  env.mgr.joinRoom(USERS.b, code);
  const room = env.mgr.getRoom(code)!;
  expect(room.startWithBot(USERS.a.userId)).toBeUndefined();
  return room;
}

/** Each human on turn picks the first free species; bots get time to think. */
function pickAll(env: Env, room: Room): void {
  let guard = 0;
  while (room.phase === 'picking' && guard++ < 10) {
    const ps = room.pickState()!;
    const seat = room.seats[ps.currentSeat!];
    if (seat.kind === 'bot') env.sched.advance(BOT_THINK_MS + 1);
    else {
      const free = SPECIES.find((s) => !room.picks.includes(s))!;
      expect(room.choose(seat.userId!, free)).toBeUndefined();
    }
  }
}

function toPlaying(env: Env, room: Room): void {
  pickAll(env, room);
  expect(room.phase).toBe('intro');
  env.sched.advance(ROUND_INTRO_MS + 1);
  expect(room.phase).toBe('playing');
}

/** Advance playing time to (just past) the given elapsed round seconds. */
function playUntil(env: Env, room: Room, sec: number): void {
  const need = sec * 1000 - room.elapsedMs;
  if (need > 0) env.sched.advance(need + 1);
}

function seatWithSpecies(room: Room, s: Species): SeatIndex {
  return room.picks.indexOf(s) as SeatIndex;
}

function finishRoundSole(env: Env, room: Room, winner: Species): void {
  const c: [number, number, number] = [0, 0, 0];
  c[SPECIES.indexOf(winner)] = 12;
  env.physics.setCounts(c);
  env.sched.advance(TICK_MS + 1);
  expect(room.phase).toBe('roundEnd');
}

describe('lobby & start', () => {
  it('auto-starts when 3 humans are seated', () => {
    const env = setup();
    const { code } = env.mgr.createRoom(USERS.a);
    const room = env.mgr.getRoom(code)!;
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/);
    expect(room.seats[0].userId).toBe(USERS.a.userId);
    expect(room.hostUserId).toBe(USERS.a.userId);
    env.mgr.joinRoom(USERS.b, code);
    expect(room.phase).toBe('lobby');
    env.mgr.joinRoom(USERS.c, code);
    expect(room.phase).toBe('picking');
    expect(room.round).toBe(1);
    expect(env.transport.last('pick:state')?.turn).toBe(0);
    // 4th user cannot join a running match
    expect(env.mgr.joinRoom(USERS.d, code)).toEqual({ ok: false, error: MSG.gameStarted });
  });

  it('start with bot: host only, exactly 2 humans', () => {
    const env = setup();
    const { code } = env.mgr.createRoom(USERS.a);
    const room = env.mgr.getRoom(code)!;
    expect(room.startWithBot(USERS.a.userId)).toBe(MSG.needTwoForBot); // only 1 human
    env.mgr.joinRoom(USERS.b, code);
    expect(room.startWithBot(USERS.b.userId)).toBe(MSG.hostOnly);
    expect(room.phase).toBe('lobby');
    expect(room.startWithBot(USERS.a.userId)).toBeUndefined();
    expect(room.phase).toBe('picking');
    const bot = room.seats.find((s) => s.kind === 'bot')!;
    expect(bot.username).toBe(BOT_NAME);
    expect(bot.replacedHuman).toBe(false);
  });

  it('round count is host-only and lobby-only', () => {
    const env = setup();
    const { code } = env.mgr.createRoom(USERS.a);
    const room = env.mgr.getRoom(code)!;
    env.mgr.joinRoom(USERS.b, code);
    expect(room.setRounds(USERS.b.userId, 3)).toBe(MSG.hostOnly);
    expect(room.setRounds(USERS.a.userId, 7)).toBe(MSG.invalidRounds);
    expect(room.setRounds(USERS.a.userId, 3)).toBeUndefined();
    expect(room.totalRounds).toBe(3);
    env.mgr.joinRoom(USERS.c, code);
    expect(room.setRounds(USERS.a.userId, 6)).toBe(MSG.gameStarted);
  });

  it('host passes on when the host leaves the lobby; empty room is deleted', () => {
    const env = setup();
    const { code } = env.mgr.createRoom(USERS.a);
    const room = env.mgr.getRoom(code)!;
    env.mgr.joinRoom(USERS.b, code);
    env.mgr.leave(USERS.a.userId);
    expect(room.hostUserId).toBe(USERS.b.userId);
    expect(room.seats[0].kind).toBe('empty');
    env.mgr.leave(USERS.b.userId);
    expect(env.mgr.getRoom(code)).toBeUndefined();
    expect(env.sched.pending).toBe(0);
  });

  it('lobby disconnect frees the seat after the reload grace', () => {
    const env = setup();
    const { code } = env.mgr.createRoom(USERS.a);
    const room = env.mgr.getRoom(code)!;
    env.mgr.joinRoom(USERS.b, code);
    env.mgr.handleDisconnect(USERS.b.userId);
    env.sched.advance(LOBBY_DISCONNECT_GRACE_MS - 10);
    expect(room.hasUser(USERS.b.userId)).toBe(true);
    env.mgr.handleConnect(USERS.b.userId); // reload came back in time
    env.sched.advance(LOBBY_DISCONNECT_GRACE_MS * 2);
    expect(room.hasUser(USERS.b.userId)).toBe(true);
    env.mgr.handleDisconnect(USERS.b.userId);
    env.sched.advance(LOBBY_DISCONNECT_GRACE_MS + 1);
    expect(room.hasUser(USERS.b.userId)).toBe(false);
    expect(env.mgr.userRoom.has(USERS.b.userId)).toBe(false);
  });
});

describe('picking', () => {
  it('rotates pick order per 3-round block and never allows duplicate species (9 rounds)', () => {
    const env = setup({ seed: 777 });
    const room = threeHumans(env);
    expect(room.totalRounds).toBe(9);
    const orders: SeatIndex[][] = [];
    for (let r = 1; r <= 9; r++) {
      expect(room.round).toBe(r);
      expect(room.phase).toBe('picking');
      const order = room.pickState()!.order;
      orders.push([...order]);
      // first picker takes something; second picker trying the same species is rejected
      const first = room.seats[order[0]].userId!;
      const second = room.seats[order[1]].userId!;
      expect(room.choose(second, 'rock')).toBe(MSG.notYourTurn);
      const s0 = SPECIES[r % 3];
      expect(room.choose(first, s0)).toBeUndefined();
      expect(room.choose(second, s0)).toBe(MSG.speciesTaken);
      pickAll(env, room);
      expect(new Set(room.picks).size).toBe(3);
      expect(room.picks.every((p) => p !== null)).toBe(true);
      env.sched.advance(ROUND_INTRO_MS + 1);
      finishRoundSole(env, room, 'rock');
      env.sched.advance(ROUND_END_DELAY_MS + 1);
    }
    expect(room.phase).toBe('matchEnd');
    for (let b = 0; b < 3; b++) {
      const block = orders.slice(b * 3, b * 3 + 3);
      // each seat picks first exactly once per block
      expect(new Set(block.map((o) => o[0])).size).toBe(3);
      // rotation of the block permutation
      const p = block[0];
      expect(block[1]).toEqual([p[1], p[2], p[0]]);
      expect(block[2]).toEqual([p[2], p[0], p[1]]);
    }
  });

  it('assigns a random untaken species when the 15 s pick timer runs out', () => {
    const env = setup();
    const room = threeHumans(env);
    const ps = room.pickState()!;
    expect(ps.remainingMs).toBe(PICK_TIME_MS);
    const firstSeat = ps.order[0];
    expect(room.choose(room.seats[firstSeat].userId!, 'paper')).toBeUndefined();
    const second = room.pickState()!.currentSeat!;
    env.sched.advance(PICK_TIME_MS - 5);
    expect(room.picks[second]).toBeNull();
    env.sched.advance(10);
    expect(room.picks[second]).not.toBeNull();
    expect(room.picks[second]).not.toBe('paper');
    expect(room.pickState()!.turn).toBe(2);
  });

  it('bot thinks for 1 s then picks a random untaken species', () => {
    const env = setup();
    const room = twoHumansAndBot(env);
    const botSeat = room.seats.findIndex((s) => s.kind === 'bot') as SeatIndex;
    // play humans until the bot is on turn
    let guard = 0;
    while (room.pickState()!.currentSeat !== botSeat && guard++ < 3) {
      const cs = room.pickState()!.currentSeat!;
      room.choose(room.seats[cs].userId!, SPECIES.find((s) => !room.picks.includes(s))!);
    }
    expect(room.pickState()!.botThinking).toBe(true);
    env.sched.advance(BOT_THINK_MS - 5);
    expect(room.picks[botSeat]).toBeNull();
    env.sched.advance(10);
    expect(room.picks[botSeat]).not.toBeNull();
    expect(env.transport.of('pick:state').some((p) => p.botThinking)).toBe(true);
  });
});

describe('round flow', () => {
  it('emits round:start with seed and snapshots with speed multiplier', () => {
    const env = setup();
    const room = threeHumans(env);
    pickAll(env, room);
    const rs = env.transport.last('round:start')!;
    expect(rs.round).toBe(1);
    expect(rs.introMs).toBe(ROUND_INTRO_MS);
    expect(rs.seatSpecies).toEqual(room.picks);
    expect(env.logs.some((l) => /round 1 seed \d+/.test(l))).toBe(true);
    env.sched.advance(ROUND_INTRO_MS + 1);
    playUntil(env, room, 31);
    const snap = env.transport.last('game:snapshot')!;
    expect(snap.speed).toBe(2);
    expect(snap.paused).toBe(false);
    playUntil(env, room, 61);
    expect(env.transport.last('game:snapshot')!.speed).toBe(5);
  });

  it('sole survivor wins the round and scores', () => {
    const env = setup();
    const room = threeHumans(env);
    toPlaying(env, room);
    const winner = seatWithSpecies(room, 'scissors');
    finishRoundSole(env, room, 'scissors');
    const re = env.transport.last('round:end')!;
    expect(re.winnerSeat).toBe(winner);
    expect(re.byVote).toBe(false);
    expect(room.scores[winner]).toBe(1);
    env.sched.advance(ROUND_END_DELAY_MS + 1);
    expect(room.round).toBe(2);
    expect(room.phase).toBe('picking');
  });
});

describe('vote', () => {
  it('is not accepted before 90 s; all eligible approving ends immediately', () => {
    const env = setup();
    const room = threeHumans(env);
    toPlaying(env, room);
    env.physics.setCounts([6, 4, 2]);
    const [a, b, c] = [USERS.a, USERS.b, USERS.c].map((u) => u.userId);
    playUntil(env, room, 89);
    room.vote(a, true);
    expect(env.transport.last('game:snapshot')!.vote.open).toBe(false);
    expect(env.transport.last('game:snapshot')!.vote.approvedSeats).toEqual([]);
    playUntil(env, room, 90);
    expect(env.transport.last('game:snapshot')!.vote.open).toBe(true);
    room.vote(a, true);
    room.vote(b, true);
    expect(room.phase).toBe('playing');
    expect(env.transport.last('game:snapshot')!.vote.approvedSeats.length).toBe(2);
    room.vote(c, true);
    expect(room.phase).toBe('roundEnd');
    const re = env.transport.last('round:end')!;
    expect(re.byVote).toBe(true);
    expect(re.winnerSpecies).toBe('rock'); // most units
    expect(re.winnerSeat).toBe(seatWithSpecies(room, 'rock'));
  });

  it('one holdout keeps the round going; approvals can be withdrawn', () => {
    const env = setup();
    const room = threeHumans(env);
    toPlaying(env, room);
    env.physics.setCounts([6, 4, 2]);
    const [a, b, c] = [USERS.a, USERS.b, USERS.c].map((u) => u.userId);
    playUntil(env, room, 91);
    room.vote(a, true);
    room.vote(b, true);
    playUntil(env, room, 120);
    expect(room.phase).toBe('playing');
    room.vote(a, false); // withdraw
    const seatA = room.seatOf(a) as SeatIndex;
    expect(env.transport.last('game:snapshot')!.vote.approvedSeats).not.toContain(seatA);
    room.vote(c, true);
    env.sched.advance(TICK_MS * 3);
    expect(room.phase).toBe('playing');
    room.vote(a, true);
    expect(room.phase).toBe('roundEnd');
  });

  it('only alive seats are eligible (re-checked every tick); tie gives no point but round counts', () => {
    const env = setup();
    const room = threeHumans(env);
    toPlaying(env, room);
    env.physics.setCounts([5, 5, 2]);
    playUntil(env, room, 91);
    const scissorsSeat = seatWithSpecies(room, 'scissors');
    room.vote(room.seats[scissorsSeat].userId!, true);
    expect(env.transport.last('game:snapshot')!.vote.approvedSeats).toEqual([scissorsSeat]);
    // scissors eliminated → its approval is discarded, it is no longer eligible
    env.physics.setCounts([5, 5, 0]);
    env.sched.advance(TICK_MS * 2 + 1);
    const v = env.transport.last('game:snapshot')!.vote;
    expect(v.eligibleSeats).not.toContain(scissorsSeat);
    expect(v.approvedSeats).toEqual([]);
    // eliminated seat cannot vote any more
    room.vote(room.seats[scissorsSeat].userId!, true);
    for (const s of ['rock', 'paper'] as Species[]) room.vote(room.seats[seatWithSpecies(room, s)].userId!, true);
    expect(room.phase).toBe('roundEnd');
    const re = env.transport.last('round:end')!;
    expect(re.winnerSeat).toBeNull();
    expect(re.scores).toEqual([0, 0, 0]);
    env.sched.advance(ROUND_END_DELAY_MS + 1);
    expect(room.round).toBe(2);
  });

  it('an alive bot auto-approves', () => {
    const env = setup();
    const room = twoHumansAndBot(env);
    toPlaying(env, room);
    env.physics.setCounts([3, 3, 7]);
    playUntil(env, room, 90.5);
    const botSeat = room.seats.findIndex((s) => s.kind === 'bot') as SeatIndex;
    expect(env.transport.last('game:snapshot')!.vote.approvedSeats).toEqual([botSeat]);
    room.vote(USERS.a.userId, true);
    expect(room.phase).toBe('playing');
    room.vote(USERS.b.userId, true);
    expect(room.phase).toBe('roundEnd');
    expect(env.transport.last('round:end')!.winnerSpecies).toBe('scissors');
  });
});

describe('disconnects', () => {
  it('pauses the sim while waiting, resumes on reconnect', () => {
    const env = setup();
    const room = threeHumans(env);
    toPlaying(env, room);
    playUntil(env, room, 10);
    env.mgr.handleDisconnect(USERS.b.userId);
    expect(room.paused?.waitingFor).toEqual([USERS.b.username]);
    expect(env.transport.last('game:snapshot')!.paused).toBe(true);
    const frozen = room.elapsedMs;
    env.sched.advance(20_000);
    expect(room.elapsedMs).toBe(frozen);
    env.transport.clear();
    expect(env.mgr.handleConnect(USERS.b.userId)).toBe(room.code);
    expect(room.paused).toBeNull();
    // reconnecting user got a full state push
    const toB = env.transport.sent.filter((e) => e.to === `user:${USERS.b.userId}`).map((e) => e.event);
    expect(toB).toEqual(expect.arrayContaining(['room:state', 'round:start', 'game:snapshot']));
    env.sched.advance(1000);
    expect(room.elapsedMs).toBeGreaterThan(frozen);
  });

  it('freezes the pick timer while paused', () => {
    const env = setup();
    const room = threeHumans(env);
    const cur = room.pickState()!.currentSeat!;
    env.sched.advance(5000);
    const other = room.seats.find((s, i) => i !== cur && s.kind === 'human')!;
    env.mgr.handleDisconnect(other.userId!);
    env.sched.advance(20_000);
    expect(room.picks[cur]).toBeNull();
    expect(room.pickState()!.remainingMs).toBe(PICK_TIME_MS - 5000);
    env.mgr.handleConnect(other.userId!);
    env.sched.advance(PICK_TIME_MS - 5000 + 1);
    expect(room.picks[cur]).not.toBeNull();
  });

  it('after 30 s a bot takes the seat and the match continues', () => {
    const env = setup();
    const room = threeHumans(env);
    toPlaying(env, room);
    const seatB = room.seatOf(USERS.b.userId) as SeatIndex;
    env.mgr.handleDisconnect(USERS.b.userId);
    expect(room.paused!.resumeDeadline).toBe(env.sched.now() + RECONNECT_GRACE_MS);
    env.sched.advance(RECONNECT_GRACE_MS - 10);
    expect(room.seats[seatB].kind).toBe('human');
    env.sched.advance(20);
    expect(room.seats[seatB].kind).toBe('bot');
    expect(room.seats[seatB].replacedHuman).toBe(true);
    expect(room.seats[seatB].username).toBe(BOT_NAME);
    expect(room.paused).toBeNull();
    expect(env.mgr.userRoom.has(USERS.b.userId)).toBe(false);
    const t = room.elapsedMs;
    env.sched.advance(1000);
    expect(room.elapsedMs).toBeGreaterThan(t);
    // b cannot rejoin the running match
    expect(env.mgr.joinRoom(USERS.b, room.code)).toEqual({ ok: false, error: MSG.gameStarted });
  });

  it('room:leave during a match = immediate bot replacement; host passes on', () => {
    const env = setup();
    const room = threeHumans(env);
    env.mgr.leave(USERS.a.userId);
    expect(room.seats[0].kind).toBe('bot');
    expect(room.hostUserId).not.toBe(USERS.a.userId);
    expect(room.paused).toBeNull();
  });

  it('deletes the room when every human is gone', () => {
    const env = setup();
    const room = twoHumansAndBot(env);
    env.mgr.handleDisconnect(USERS.a.userId);
    env.mgr.handleDisconnect(USERS.b.userId);
    env.sched.advance(RECONNECT_GRACE_MS + 10);
    expect(room.destroyed).toBe(true);
    expect(env.mgr.rooms.size).toBe(0);
    expect(env.sched.pending).toBe(0);
  });
});

describe('match end, stats, rematch, rename', () => {
  function playMatch(env: Env, room: Room, winners: Species[] | ((r: number) => Species)) {
    for (let r = 1; r <= room.totalRounds; r++) {
      toPlaying(env, room);
      const w = typeof winners === 'function' ? winners(r) : winners[r - 1];
      finishRoundSole(env, room, w);
      env.sched.advance(ROUND_END_DELAY_MS + 1);
    }
  }

  it('ties share the win; results saved for every human', () => {
    const env = setup();
    const room = threeHumans(env);
    room.totalRounds = 3;
    // make seat 0 and seat 1 each win once, seat 2 once → all tied at 1
    const order: SeatIndex[] = [0, 1, 2];
    playMatch(env, room, (r) => room.picks[order[r - 1]]!);
    expect(room.phase).toBe('matchEnd');
    const me = env.transport.last('match:end')!;
    expect(me.scores).toEqual([1, 1, 1]);
    expect(me.winners).toEqual([0, 1, 2]);
    expect(env.saved).toHaveLength(1);
    const res = env.saved[0].results;
    expect(res).toHaveLength(3);
    expect(res.every((r) => r.isWinner && r.finishedInSeat && r.roundsWon === 1)).toBe(true);
  });

  it('bot winning alone gives humans no win', () => {
    const env = setup();
    const room = twoHumansAndBot(env);
    room.totalRounds = 3;
    const botSeat = room.seats.findIndex((s) => s.kind === 'bot');
    playMatch(env, room, () => room.picks[botSeat]!);
    const me = env.transport.last('match:end')!;
    expect(me.winners).toEqual([botSeat]);
    expect(me.standings[0].kind).toBe('bot');
    const res = env.saved[0].results;
    expect(res).toHaveLength(2);
    expect(res.every((r) => !r.isWinner && r.roundsWon === 0 && r.finishedInSeat)).toBe(true);
  });

  it('replaced player: finishedInSeat=false, keeps rounds won while seated, no win', () => {
    const env = setup();
    const room = threeHumans(env);
    room.totalRounds = 3;
    const seatB = room.seatOf(USERS.b.userId) as SeatIndex;
    // round 1: b wins
    toPlaying(env, room);
    finishRoundSole(env, room, room.picks[seatB]!);
    env.sched.advance(ROUND_END_DELAY_MS + 1);
    // b drops and times out
    env.mgr.handleDisconnect(USERS.b.userId);
    env.sched.advance(RECONNECT_GRACE_MS + 10);
    expect(room.seats[seatB].kind).toBe('bot');
    // rounds 2,3: the bot in b's old seat wins
    for (let r = 2; r <= 3; r++) {
      toPlaying(env, room);
      finishRoundSole(env, room, room.picks[seatB]!);
      env.sched.advance(ROUND_END_DELAY_MS + 1);
    }
    expect(room.phase).toBe('matchEnd');
    expect(env.transport.last('match:end')!.winners).toEqual([seatB]);
    const res = env.saved[0].results;
    const rb = res.find((r) => r.userId === USERS.b.userId)!;
    expect(rb).toEqual({ userId: USERS.b.userId, roundsWon: 1, isWinner: false, finishedInSeat: false });
    expect(res.filter((r) => r.userId !== USERS.b.userId).every((r) => !r.isWinner && r.finishedInSeat)).toBe(true);
  });

  it('rematch returns to lobby without bots and auto-starts with 3 humans', () => {
    const env = setup();
    const room = twoHumansAndBot(env);
    room.totalRounds = 3;
    playMatch(env, room, ['rock', 'rock', 'rock']);
    expect(room.phase).toBe('matchEnd');
    expect(room.rematch(USERS.b.userId)).toBeUndefined();
    expect(room.phase).toBe('lobby');
    expect(room.seats.some((s) => s.kind === 'bot')).toBe(false);
    expect(room.scores).toEqual([0, 0, 0]);
    expect(room.hostUserId).toBe(USERS.a.userId);
    expect(env.mgr.joinRoom(USERS.c, room.code).ok).toBe(true);
    expect(room.phase).toBe('picking');
  });

  it('rename propagates into the seat and rebroadcasts room:state', () => {
    const env = setup();
    const { code } = env.mgr.createRoom(USERS.a);
    env.transport.clear();
    env.mgr.renameUser(USERS.a.userId, 'YeniAd');
    const st = env.transport.last('room:state')!;
    expect(st.code).toBe(code);
    expect(st.seats[0].username).toBe('YeniAd');
  });
});
