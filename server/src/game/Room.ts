// Authoritative room state machine:
//   lobby → picking → intro → playing → roundEnd → (picking …) → matchEnd → (rematch) lobby
// Transport-agnostic: emits through deps.emit; time comes from deps.scheduler.
import {
  BOT_NAME,
  BOT_THINK_MS,
  PICK_TIME_MS,
  QUICK_MATCH_BOT_WAIT_MS,
  RECONNECT_GRACE_MS,
  ROUND_END_DELAY_MS,
  ROUND_INTRO_MS,
  ROUND_OPTIONS,
  SNAPSHOT_EVERY_TICKS,
  SPECIES_INDEX,
  TICK_MS,
  TICK_RATE,
  VOTE_OPEN_SEC,
  type GameSnapshot,
  type MatchEnd,
  type PickState,
  type RoomPhase,
  type RoomState,
  type RoundEnd,
  type RoundOption,
  type RoundStart,
  type SeatIndex,
  type SeatInfo,
  type SeatKind,
  type ServerToClientEvents,
  type Species,
  type Standing,
  type VoteInfo,
} from '@tkm/shared';
import type { SimApi, SimState } from '../sim/api.js';
import type { MatchRecord } from '../db/types.js';
import { MSG } from '../errors.js';
import { randomUntaken } from './bot.js';
import { computeMatchResults, type Participant } from './results.js';
import type { Scheduler, TimerHandle } from './scheduler.js';

/** Lobby / match-end reload grace before a disconnected human loses the seat. */
export const LOBBY_DISCONNECT_GRACE_MS = 5_000;

export type ServerEvent = keyof ServerToClientEvents;
export type EventPayload<E extends ServerEvent> = Parameters<ServerToClientEvents[E]>[0];
export interface Packet<E extends ServerEvent = ServerEvent> {
  event: E;
  payload: EventPayload<E>;
}
export type Emit = <E extends ServerEvent>(event: E, payload: EventPayload<E>) => void;

export interface RoomUser {
  userId: string;
  username: string;
  avatarUrl: string | null;
}

export interface RoomDeps {
  sim: SimApi;
  scheduler: Scheduler;
  /** Non-seeded randomness for perms, picks, seeds (Math.random in prod). */
  random: () => number;
  unitsPerType: number;
  /** Broadcast to everyone in the room. */
  emit: Emit;
  /** Persist the finished match (errors handled by caller). */
  onMatchEnd: (record: MatchRecord) => void;
  /** A human no longer belongs to this room (left, removed, or replaced by a bot). */
  onUserRemoved: (userId: string) => void;
  /** No humans left: the room must be deleted. */
  onEmpty: () => void;
  log?: (msg: string) => void;
}

/** Undefined result = success; string = error for error:msg. */
export type ActionResult = string | undefined;

interface Seat {
  kind: SeatKind;
  userId: string | null;
  username: string | null;
  avatarUrl: string | null;
  connected: boolean;
  replacedHuman: boolean;
  /** Epoch ms at which a disconnected human is replaced by a bot (in-match only). */
  disconnectDeadline: number | null;
}

interface PhaseTimer {
  fn: () => void;
  handle: TimerHandle | null;
  fireAt: number;
  /** remaining ms while frozen */
  remaining: number;
}

interface PickRuntime {
  order: [SeatIndex, SeatIndex, SeatIndex];
  turn: number;
  botThinking: boolean;
}

const IN_MATCH: ReadonlySet<RoomPhase> = new Set(['picking', 'intro', 'playing', 'roundEnd']);
const SEAT_IDX: readonly SeatIndex[] = [0, 1, 2];

function emptySeat(): Seat {
  return { kind: 'empty', userId: null, username: null, avatarUrl: null, connected: false, replacedHuman: false, disconnectDeadline: null };
}
function botSeat(replacedHuman: boolean): Seat {
  return { kind: 'bot', userId: null, username: BOT_NAME, avatarUrl: null, connected: true, replacedHuman, disconnectDeadline: null };
}

export class Room {
  readonly code: string;
  /** Matchmaking ("Quick match") room: open to room:quick while in lobby, auto-starts with a bot. */
  readonly quick: boolean;
  /** Solo practice room: 1 human + 2 bots, starts immediately, never saves stats, not joinable. */
  readonly practice: boolean;
  hostUserId: string;
  totalRounds: RoundOption;
  phase: RoomPhase = 'lobby';
  round = 0;
  seats: [Seat, Seat, Seat] = [emptySeat(), emptySeat(), emptySeat()];
  scores: [number, number, number] = [0, 0, 0];
  picks: [Species | null, Species | null, Species | null] = [null, null, null];
  paused: { waitingFor: string[]; resumeDeadline: number } | null = null;
  destroyed = false;

  private pick: PickRuntime | null = null;
  private blockPerm: [SeatIndex, SeatIndex, SeatIndex] = [0, 1, 2];
  private timer: PhaseTimer | null = null;
  private graceTimer: TimerHandle | null = null;
  private lobbyGrace = new Map<string, TimerHandle>();
  private loop: TimerHandle | null = null;
  /** Quick match: lobby auto-start timer while exactly 2 humans wait (key = the pair's user ids). */
  private quickTimer: { handle: TimerHandle; fireAt: number; key: string } | null = null;

  private simState: SimState | null = null;
  private seatSpecies: [Species, Species, Species] | null = null;
  private playTicks = 0;
  private approvals = new Set<SeatIndex>();
  private lastCounts: [number, number, number] = [0, 0, 0];
  private lastVote: VoteInfo = { open: false, eligibleSeats: [], approvedSeats: [] };
  private lastRoundStart: RoundStart | null = null;
  private lastRoundEnd: RoundEnd | null = null;
  private lastMatchEnd: MatchEnd | null = null;

  private participants = new Map<string, Participant>();
  private startedAt = 0;

  constructor(
    code: string,
    host: RoomUser,
    totalRounds: RoundOption,
    private deps: RoomDeps,
    opts: { quick?: boolean; practice?: boolean } = {},
  ) {
    this.quick = opts.quick === true && opts.practice !== true;
    this.practice = opts.practice === true;
    this.code = code;
    this.hostUserId = host.userId;
    this.totalRounds = totalRounds;
    this.seats[0] = this.humanSeat(host);
  }

  // ------------------------------------------------------------------ queries

  private get s(): Scheduler {
    return this.deps.scheduler;
  }

  private log(msg: string): void {
    (this.deps.log ?? console.log)(`[room ${this.code}] ${msg}`);
  }

  private humanSeat(u: RoomUser): Seat {
    return { kind: 'human', userId: u.userId, username: u.username, avatarUrl: u.avatarUrl, connected: true, replacedHuman: false, disconnectDeadline: null };
  }

  seatOf(userId: string): SeatIndex | -1 {
    const i = this.seats.findIndex((s) => s.kind === 'human' && s.userId === userId);
    return i as SeatIndex | -1;
  }

  hasUser(userId: string): boolean {
    return this.seatOf(userId) !== -1;
  }

  humanCount(): number {
    return this.seats.filter((s) => s.kind === 'human').length;
  }

  hasEmptySeat(): boolean {
    return this.seats.some((s) => s.kind === 'empty');
  }

  /** Open to matchmaking: a quick room in lobby with a free seat. */
  get openForQuickMatch(): boolean {
    return this.quick && !this.destroyed && this.phase === 'lobby' && this.hasEmptySeat();
  }

  get inMatch(): boolean {
    return IN_MATCH.has(this.phase);
  }

  get elapsedMs(): number {
    return (this.playTicks * 1000) / TICK_RATE;
  }

  toState(): RoomState {
    const seats = this.seats.map(
      (s, i): SeatInfo => ({
        index: i as SeatIndex,
        kind: s.kind,
        userId: s.kind === 'human' ? s.userId : null,
        username: s.username,
        avatarUrl: s.avatarUrl,
        connected: s.kind === 'bot' ? true : s.kind === 'human' ? s.connected : false,
        isHost: s.kind === 'human' && s.userId === this.hostUserId,
        replacedHuman: s.replacedHuman,
      }),
    ) as [SeatInfo, SeatInfo, SeatInfo];
    return {
      code: this.code,
      phase: this.phase,
      hostUserId: this.hostUserId,
      totalRounds: this.totalRounds,
      unitsPerType: this.deps.unitsPerType,
      round: this.round,
      seats,
      scores: [...this.scores],
      picks: [...this.picks],
      practice: this.practice,
      quick: this.quick ? { autoStartInMs: this.quickTimer ? Math.max(0, Math.round(this.quickTimer.fireAt - this.s.now())) : null } : null,
      paused: this.paused ? { waitingFor: [...this.paused.waitingFor], resumeDeadline: this.paused.resumeDeadline } : null,
    };
  }

  pickState(): PickState | null {
    if (!this.pick) return null;
    const { order, turn, botThinking } = this.pick;
    return {
      round: this.round,
      order: [...order],
      turn,
      currentSeat: turn < 3 ? order[turn] : null,
      remainingMs: turn < 3 ? Math.round(this.timerRemaining()) : 0,
      botThinking,
      picks: [...this.picks],
      locked: this.picks.filter((p): p is Species => p !== null),
    };
  }

  /** Everything a (re)connecting client needs to rebuild its view. */
  syncPackets(): Packet[] {
    const out: Packet[] = [{ event: 'room:state', payload: this.toState() }];
    if (this.phase === 'picking') {
      const ps = this.pickState();
      if (ps) out.push({ event: 'pick:state', payload: ps });
    }
    if ((this.phase === 'intro' || this.phase === 'playing' || this.phase === 'roundEnd') && this.lastRoundStart) {
      const introMs = this.phase === 'intro' ? Math.round(this.timerRemaining()) : 0;
      out.push({ event: 'round:start', payload: { ...this.lastRoundStart, introMs } });
      if (this.simState) out.push({ event: 'game:snapshot', payload: this.buildSnapshot([]) });
    }
    if (this.phase === 'roundEnd' && this.lastRoundEnd) {
      out.push({ event: 'round:end', payload: { ...this.lastRoundEnd, nextInMs: Math.round(this.timerRemaining()) } });
    }
    if (this.phase === 'matchEnd' && this.lastMatchEnd) {
      out.push({ event: 'match:end', payload: this.lastMatchEnd });
    }
    return out;
  }

  // ------------------------------------------------------------------ emit helpers

  private emit<E extends ServerEvent>(event: E, payload: EventPayload<E>): void {
    if (!this.destroyed) this.deps.emit(event, payload);
  }

  emitState(): void {
    // Every broadcast follows a state change: re-evaluate the quick-match timer first so the
    // payload carries the up-to-date autoStartInMs.
    this.syncQuickTimer();
    this.emit('room:state', this.toState());
  }

  // ------------------------------------------------------------------ quick match auto-start

  /**
   * Quick rooms in lobby with exactly 2 humans run a QUICK_MATCH_BOT_WAIT_MS timer (restarted when the
   * pair changes); any other situation cancels it. A disconnected human still counts until removed.
   */
  private syncQuickTimer(): void {
    if (!this.quick || this.destroyed || this.phase !== 'lobby' || this.humanCount() !== 2 || !this.hasEmptySeat()) {
      this.cancelQuickTimer();
      return;
    }
    const key = this.seats
      .filter((s) => s.kind === 'human')
      .map((s) => s.userId)
      .sort()
      .join('|');
    if (this.quickTimer?.key === key) return;
    this.cancelQuickTimer();
    const handle = this.s.setTimeout(() => this.onQuickTimer(handle), QUICK_MATCH_BOT_WAIT_MS);
    this.quickTimer = { handle, fireAt: this.s.now() + QUICK_MATCH_BOT_WAIT_MS, key };
  }

  private cancelQuickTimer(): void {
    if (this.quickTimer) this.s.clearTimeout(this.quickTimer.handle);
    this.quickTimer = null;
  }

  private onQuickTimer(handle: TimerHandle): void {
    if (this.quickTimer?.handle !== handle) return;
    this.quickTimer = null;
    if (this.destroyed || this.phase !== 'lobby' || this.humanCount() !== 2) return;
    const free = this.seats.findIndex((s) => s.kind === 'empty');
    if (free === -1) return;
    this.log('quick match: no third player — starting with a bot');
    this.seats[free] = botSeat(false);
    this.startMatch();
  }

  private emitPick(): void {
    const ps = this.pickState();
    if (ps) this.emit('pick:state', ps);
  }

  // ------------------------------------------------------------------ phase timer (freezable)

  private schedule(ms: number, fn: () => void): void {
    this.clearTimer();
    const t: PhaseTimer = { fn, handle: null, fireAt: this.s.now() + ms, remaining: ms };
    this.timer = t;
    if (!this.paused) this.armTimer(t, ms);
  }

  private armTimer(t: PhaseTimer, ms: number): void {
    t.fireAt = this.s.now() + ms;
    t.handle = this.s.setTimeout(() => {
      if (this.timer !== t) return;
      this.timer = null;
      t.fn();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer?.handle) this.s.clearTimeout(this.timer.handle);
    this.timer = null;
  }

  private freezeTimer(): void {
    const t = this.timer;
    if (!t || !t.handle) return;
    this.s.clearTimeout(t.handle);
    t.handle = null;
    t.remaining = Math.max(0, t.fireAt - this.s.now());
  }

  private thawTimer(): void {
    const t = this.timer;
    if (!t || t.handle) return;
    this.armTimer(t, t.remaining);
  }

  private timerRemaining(): number {
    const t = this.timer;
    if (!t) return 0;
    return t.handle ? Math.max(0, t.fireAt - this.s.now()) : t.remaining;
  }

  // ------------------------------------------------------------------ lobby actions

  /** Seat a new human (lobby only; caller checks reconnect / in-progress cases). */
  addHuman(user: RoomUser): ActionResult {
    if (this.destroyed) return MSG.roomNotFound;
    if (this.hasUser(user.userId)) return undefined;
    if (this.phase !== 'lobby') return MSG.gameStarted;
    const free = this.seats.findIndex((s) => s.kind === 'empty');
    if (free === -1) return MSG.roomFull;
    this.seats[free] = this.humanSeat(user);
    this.emitState();
    if (this.humanCount() === 3) this.startMatch();
    return undefined;
  }

  setRounds(userId: string, n: number): ActionResult {
    if (this.quick) return MSG.quickRoundsFixed;
    if (userId !== this.hostUserId) return MSG.hostOnly;
    if (this.phase !== 'lobby') return MSG.gameStarted;
    if (!(ROUND_OPTIONS as readonly number[]).includes(n)) return MSG.invalidRounds;
    this.totalRounds = n as RoundOption;
    this.emitState();
    return undefined;
  }

  startWithBot(userId: string): ActionResult {
    if (userId !== this.hostUserId) return MSG.hostOnly;
    if (this.phase !== 'lobby') return MSG.gameStarted;
    if (this.humanCount() !== 2) return MSG.needTwoForBot;
    const free = this.seats.findIndex((s) => s.kind === 'empty');
    if (free === -1) return MSG.needTwoForBot;
    this.seats[free] = botSeat(false);
    this.startMatch();
    return undefined;
  }

  /** Practice: fill every empty seat with a bot and start right away (creation and rematch). */
  startPractice(): void {
    if (!this.practice || this.destroyed || this.inMatch) return;
    for (const i of SEAT_IDX) if (this.seats[i].kind === 'empty') this.seats[i] = botSeat(false);
    this.startMatch();
  }

  rematch(userId: string): ActionResult {
    if (this.phase !== 'matchEnd') return undefined;
    if (!this.hasUser(userId)) return MSG.notInRoom;
    for (const i of SEAT_IDX) {
      const seat = this.seats[i];
      if (seat.kind === 'bot') this.seats[i] = emptySeat();
      else if (seat.kind === 'human' && !seat.connected) this.removeHuman(i, false);
    }
    if (this.destroyed) return undefined;
    this.resetMatchState();
    this.phase = 'lobby';
    if (this.practice) {
      this.startPractice(); // straight into a new practice match (no lobby broadcast)
      return undefined;
    }
    this.emitState();
    if (this.humanCount() === 3) this.startMatch();
    return undefined;
  }

  private resetMatchState(): void {
    this.clearTimer();
    this.stopLoop();
    this.round = 0;
    this.scores = [0, 0, 0];
    this.picks = [null, null, null];
    this.pick = null;
    this.paused = null;
    this.simState = null;
    this.seatSpecies = null;
    this.playTicks = 0;
    this.approvals.clear();
    this.lastRoundStart = null;
    this.lastRoundEnd = null;
    this.lastMatchEnd = null;
    this.participants.clear();
    for (const s of this.seats) {
      s.disconnectDeadline = null;
      s.replacedHuman = s.kind === 'bot' ? s.replacedHuman : false;
    }
  }

  // ------------------------------------------------------------------ membership / connectivity

  /** Explicit room:leave. In a match the seat is taken over by a bot immediately. */
  leave(userId: string): void {
    const i = this.seatOf(userId);
    if (i === -1) return;
    if (this.inMatch) {
      this.replaceWithBot(i);
      if (this.destroyed) return;
      this.updatePause();
    } else {
      this.removeHuman(i, false);
      if (this.destroyed) return;
    }
    this.emitState();
  }

  /** Last socket of this user disconnected. */
  userDisconnected(userId: string): void {
    const i = this.seatOf(userId);
    if (i === -1) return;
    const seat = this.seats[i];
    seat.connected = false;
    if (this.inMatch) {
      this.log(`${seat.username} disconnected — pausing`);
      this.updatePause();
    } else {
      this.s.clearTimeout(this.lobbyGrace.get(userId));
      this.lobbyGrace.set(
        userId,
        this.s.setTimeout(() => {
          this.lobbyGrace.delete(userId);
          const j = this.seatOf(userId);
          if (j === -1 || this.seats[j].connected || this.inMatch) return;
          this.removeHuman(j, false);
          if (!this.destroyed) this.emitState();
        }, LOBBY_DISCONNECT_GRACE_MS),
      );
    }
    this.emitState();
  }

  /** User has a live socket again (auto re-attach or room:join). */
  userReconnected(userId: string): void {
    const i = this.seatOf(userId);
    if (i === -1) return;
    const seat = this.seats[i];
    this.s.clearTimeout(this.lobbyGrace.get(userId));
    this.lobbyGrace.delete(userId);
    if (seat.connected) return;
    seat.connected = true;
    seat.disconnectDeadline = null;
    if (this.inMatch) {
      this.log(`${seat.username} reconnected`);
      this.updatePause();
    }
    this.emitState();
  }

  renameUser(userId: string, username: string): void {
    const i = this.seatOf(userId);
    if (i === -1) return;
    this.seats[i].username = username;
    if (this.paused) this.paused.waitingFor = this.waitingSeats().map((s) => s.username ?? '');
    this.emitState();
  }

  private waitingSeats(): Seat[] {
    return this.seats.filter((s) => s.kind === 'human' && !s.connected);
  }

  /** Remove a human from the seat entirely (lobby / matchEnd). */
  private removeHuman(i: SeatIndex, emit = true): void {
    const uid = this.seats[i].userId;
    this.seats[i] = emptySeat();
    if (uid) {
      this.s.clearTimeout(this.lobbyGrace.get(uid));
      this.lobbyGrace.delete(uid);
      this.deps.onUserRemoved(uid);
    }
    if (!this.ensureHost()) return;
    if (emit) this.emitState();
  }

  /** In-match: a bot takes over the human's seat for the rest of the match. */
  private replaceWithBot(i: SeatIndex): void {
    const seat = this.seats[i];
    const uid = seat.userId;
    if (seat.kind !== 'human' || !uid) return;
    if (this.practice) {
      // Practice: no bot takeover — the room simply closes.
      this.log(`${seat.username} left practice — closing`);
      this.seats[i] = emptySeat();
      this.deps.onUserRemoved(uid);
      this.ensureHost();
      return;
    }
    this.log(`${seat.username} replaced by bot (seat ${i})`);
    const p = this.participants.get(uid);
    if (p) p.finishedInSeat = false;
    this.seats[i] = botSeat(true);
    this.approvals.delete(i);
    this.deps.onUserRemoved(uid);
    if (!this.ensureHost()) return;
    if (this.phase === 'picking' && this.pick && this.pick.turn < 3 && this.pick.order[this.pick.turn] === i) {
      this.beginTurn(); // bot takes over the pending pick
    }
  }

  /** Make sure the host is a seated human. Returns false if the room was destroyed. */
  private ensureHost(): boolean {
    const humans = this.seats.filter((s) => s.kind === 'human');
    if (humans.length === 0) {
      this.destroy();
      return false;
    }
    if (!humans.some((s) => s.userId === this.hostUserId)) this.hostUserId = humans[0].userId!;
    return true;
  }

  /** Recompute pause state from disconnected humans (in-match only). Caller emits room:state. */
  private updatePause(): void {
    if (!this.inMatch || this.destroyed) return;
    const now = this.s.now();
    const waiting = this.waitingSeats();
    for (const s of waiting) if (s.disconnectDeadline === null) s.disconnectDeadline = now + RECONNECT_GRACE_MS;
    this.s.clearTimeout(this.graceTimer);
    this.graceTimer = null;

    if (waiting.length > 0) {
      const deadline = Math.min(...waiting.map((s) => s.disconnectDeadline!));
      const wasPaused = this.paused !== null;
      this.paused = { waitingFor: waiting.map((s) => s.username ?? ''), resumeDeadline: deadline };
      if (!wasPaused) {
        this.freezeTimer();
        this.stopLoop();
        if (this.simState && (this.phase === 'playing' || this.phase === 'intro')) this.emit('game:snapshot', this.buildSnapshot([]));
        if (this.phase === 'picking') this.emitPick();
      }
      this.graceTimer = this.s.setTimeout(() => this.onGraceTimeout(), Math.max(0, deadline - now));
    } else if (this.paused) {
      this.paused = null;
      this.thawTimer();
      if (this.phase === 'playing') {
        this.startLoop();
        if (this.simState) this.emit('game:snapshot', this.buildSnapshot([]));
      }
      if (this.phase === 'picking') this.emitPick();
    }
  }

  private onGraceTimeout(): void {
    this.graceTimer = null;
    const now = this.s.now();
    for (const i of SEAT_IDX) {
      const seat = this.seats[i];
      if (seat.kind === 'human' && !seat.connected && seat.disconnectDeadline !== null && seat.disconnectDeadline <= now) {
        this.replaceWithBot(i);
        if (this.destroyed) return;
      }
    }
    this.updatePause();
    this.emitState();
  }

  // ------------------------------------------------------------------ match flow

  private startMatch(): void {
    this.cancelQuickTimer();
    this.resetMatchState();
    this.startedAt = this.s.now();
    for (const i of SEAT_IDX) {
      const seat = this.seats[i];
      if (seat.kind === 'human' && seat.userId) {
        this.participants.set(seat.userId, { userId: seat.userId, seat: i, roundsWon: 0, finishedInSeat: true });
        // lobby reload-grace no longer applies; in-match pause rules take over
        this.s.clearTimeout(this.lobbyGrace.get(seat.userId));
        this.lobbyGrace.delete(seat.userId);
      }
    }
    this.log(`match start (${this.totalRounds} rounds)`);
    this.startRound(1);
    this.updatePause();
    if (this.paused) this.emitState();
  }

  private startRound(r: number): void {
    this.round = r;
    this.picks = [null, null, null];
    this.approvals.clear();
    this.simState = null;
    this.seatSpecies = null;
    this.playTicks = 0;
    this.lastRoundStart = null;
    this.lastRoundEnd = null;
    const roundInBlock = (r - 1) % 3;
    if (roundInBlock === 0) this.blockPerm = this.deps.sim.randomSeatPerm(this.deps.random);
    this.pick = { order: this.deps.sim.pickOrder(this.blockPerm, roundInBlock), turn: 0, botThinking: false };
    this.phase = 'picking';
    this.emitState();
    this.beginTurn();
  }

  private beginTurn(): void {
    const pick = this.pick;
    if (!pick) return;
    if (pick.turn >= 3) {
      this.finishPicks();
      return;
    }
    const seatIdx = pick.order[pick.turn];
    if (this.seats[seatIdx].kind === 'bot') {
      pick.botThinking = true;
      this.schedule(BOT_THINK_MS, () => {
        pick.botThinking = false;
        this.applyPick(seatIdx, randomUntaken(this.picks, this.deps.random));
      });
    } else {
      pick.botThinking = false;
      this.schedule(PICK_TIME_MS, () => this.applyPick(seatIdx, randomUntaken(this.picks, this.deps.random)));
    }
    this.emitPick();
  }

  /** pick:choose from a human. */
  choose(userId: string, species: Species): ActionResult {
    const i = this.seatOf(userId);
    if (i === -1) return MSG.notInRoom;
    if (this.phase !== 'picking' || !this.pick || this.pick.turn >= 3) return MSG.notYourTurn;
    if (this.paused) return MSG.paused;
    if (this.pick.order[this.pick.turn] !== i) return MSG.notYourTurn;
    if (!(species in SPECIES_INDEX)) return MSG.badRequest;
    if (this.picks.includes(species)) return MSG.speciesTaken;
    this.applyPick(i, species);
    return undefined;
  }

  private applyPick(seat: SeatIndex, species: Species): void {
    const pick = this.pick;
    if (!pick || this.picks.includes(species) || this.picks[seat] !== null) return;
    this.clearTimer();
    this.picks[seat] = species;
    pick.turn += 1;
    pick.botThinking = false;
    this.emitState();
    this.beginTurn(); // emits pick:state (or finishes picks)
  }

  private finishPicks(): void {
    const pick = this.pick;
    if (pick) {
      pick.botThinking = false;
      this.emitPick(); // turn === 3
    }
    const seatSpecies = this.picks as [Species, Species, Species];
    const seed = Math.floor(this.deps.random() * 0x1_0000_0000) >>> 0;
    this.log(`round ${this.round} seed ${seed}`);
    this.seatSpecies = [...seatSpecies];
    this.simState = this.deps.sim.createRound(seed, this.deps.unitsPerType);
    this.playTicks = 0;
    this.approvals.clear();
    this.lastCounts = this.deps.sim.speciesCounts(this.simState);
    this.lastVote = this.computeVote(this.lastCounts).info;
    this.deps.sim.drainConverted(this.simState);
    this.lastRoundStart = {
      round: this.round,
      seed,
      map: this.simState.map,
      seatSpecies: [...seatSpecies],
      unitCount: this.simState.units.length,
      introMs: ROUND_INTRO_MS,
    };
    this.phase = 'intro';
    this.emitState();
    this.emit('round:start', this.lastRoundStart);
    this.emit('game:snapshot', this.buildSnapshot([]));
    this.schedule(ROUND_INTRO_MS, () => this.startPlaying());
  }

  private startPlaying(): void {
    this.phase = 'playing';
    this.emitState();
    this.startLoop();
  }

  private startLoop(): void {
    if (this.loop || this.paused || this.phase !== 'playing') return;
    this.loop = this.s.setInterval(() => this.tick(), TICK_MS);
  }

  private stopLoop(): void {
    if (this.loop) this.s.clearInterval(this.loop);
    this.loop = null;
  }

  private computeVote(counts: [number, number, number]) {
    const effective = new Set(this.approvals);
    for (const i of SEAT_IDX) if (this.seats[i].kind === 'bot') effective.add(i); // alive bots always approve
    const v = this.deps.sim.evaluateVote({
      elapsedSec: this.elapsedMs / 1000,
      seatSpecies: this.seatSpecies!,
      counts,
      approvals: effective,
    });
    // approvals of eliminated seats are discarded
    for (const a of [...this.approvals]) if (!v.eligibleSeats.includes(a)) this.approvals.delete(a);
    // Before the vote opens nobody (not even a bot) is shown as approving.
    const info: VoteInfo = { open: v.open, eligibleSeats: [...v.eligibleSeats], approvedSeats: v.open ? [...v.approvedSeats] : [] };
    return { info, allApproved: v.allApproved };
  }

  private buildSnapshot(converted: number[]): GameSnapshot {
    const st = this.simState!;
    return {
      tick: this.playTicks,
      elapsedMs: Math.round(this.elapsedMs),
      speed: this.deps.sim.speedAt(this.elapsedMs / 1000),
      units: this.deps.sim.packUnits(st),
      counts: [...this.lastCounts],
      converted,
      vote: this.lastVote,
      paused: this.paused !== null,
    };
  }

  /** One game-loop tick (TICK_MS of round time). */
  tick(): void {
    if (this.phase !== 'playing' || this.paused || !this.simState || this.destroyed) return;
    this.playTicks += 1;
    const mult = this.deps.sim.speedAt(this.elapsedMs / 1000);
    const res = this.deps.sim.tickSim(this.simState, mult);
    this.lastCounts = res.counts;
    const vote = this.computeVote(res.counts);
    this.lastVote = vote.info;

    if (res.soleSurvivor) {
      this.endRound(res.soleSurvivor, false);
    } else if (vote.allApproved) {
      this.endRound(this.deps.sim.voteWinner(res.counts), true);
    } else if (this.playTicks % SNAPSHOT_EVERY_TICKS === 0) {
      this.emit('game:snapshot', this.buildSnapshot(this.deps.sim.drainConverted(this.simState)));
    }
  }

  /** vote:set — ignored unless the vote is open and the seat's species is alive. */
  vote(userId: string, approve: boolean): ActionResult {
    const i = this.seatOf(userId);
    if (i === -1 || this.phase !== 'playing' || this.paused || !this.simState || !this.seatSpecies) return undefined;
    if (this.elapsedMs / 1000 < VOTE_OPEN_SEC) return undefined;
    const counts = this.deps.sim.speciesCounts(this.simState);
    if (counts[SPECIES_INDEX[this.seatSpecies[i]]] <= 0) return undefined;
    if (approve) this.approvals.add(i);
    else this.approvals.delete(i);
    const v = this.computeVote(counts);
    this.lastVote = v.info;
    if (v.allApproved) this.endRound(this.deps.sim.voteWinner(counts), true);
    else this.emit('game:snapshot', this.buildSnapshot([]));
    return undefined;
  }

  private endRound(winnerSpecies: Species | null, byVote: boolean): void {
    this.stopLoop();
    const st = this.simState!;
    const counts = this.deps.sim.speciesCounts(st);
    this.lastCounts = counts;
    // final snapshot so clients see the end state
    this.emit('game:snapshot', this.buildSnapshot(this.deps.sim.drainConverted(st)));

    let winnerSeat: SeatIndex | null = null;
    if (winnerSpecies && this.seatSpecies) {
      const idx = this.seatSpecies.indexOf(winnerSpecies);
      if (idx !== -1) winnerSeat = idx as SeatIndex;
    }
    if (winnerSeat !== null) {
      this.scores[winnerSeat] += 1;
      const seat = this.seats[winnerSeat];
      if (seat.kind === 'human' && seat.userId) {
        const p = this.participants.get(seat.userId);
        if (p && p.finishedInSeat) p.roundsWon += 1;
      }
    }
    this.log(
      `round ${this.round} end: winner ${winnerSpecies ?? 'none'}${winnerSeat !== null ? ` (seat ${winnerSeat})` : ''}${byVote ? ' by vote' : ''} @${Math.round(this.elapsedMs)}ms`,
    );
    this.phase = 'roundEnd';
    this.lastRoundEnd = {
      round: this.round,
      winnerSpecies,
      winnerSeat,
      byVote,
      counts: [...counts],
      scores: [...this.scores],
      nextInMs: ROUND_END_DELAY_MS,
    };
    this.emitState();
    this.emit('round:end', this.lastRoundEnd);
    this.schedule(ROUND_END_DELAY_MS, () => {
      if (this.round < this.totalRounds) this.startRound(this.round + 1);
      else this.endMatch();
    });
  }

  private endMatch(): void {
    this.stopLoop();
    this.clearTimer();
    this.pick = null;
    const { rank, winners } = this.deps.sim.rankSeats(this.scores);
    const standings: Standing[] = SEAT_IDX.map((i) => ({
      seat: i,
      username: this.seats[i].username ?? '',
      kind: this.seats[i].kind,
      roundsWon: this.scores[i],
      rank: rank[i],
    })).sort((a, b) => a.rank - b.rank || a.seat - b.seat);
    this.lastMatchEnd = { standings, winners: [...winners], scores: [...this.scores] };
    this.phase = 'matchEnd';
    this.paused = null;

    const results = computeMatchResults(this.seats, this.participants.values(), winners);
    this.log(`match end: scores ${this.scores.join('-')} winners [${winners.join(',')}]`);
    this.emit('match:end', this.lastMatchEnd);
    this.emitState();
    if (results.length > 0 && !this.practice) {
      try {
        this.deps.onMatchEnd({ roomCode: this.code, totalRounds: this.totalRounds, startedAt: this.startedAt, results });
      } catch (err) {
        this.log(`saveMatch failed: ${String(err)}`);
      }
    }
    // Humans who are offline at match end get the normal reload grace, then lose the seat.
    for (const seat of this.seats) {
      if (seat.kind === 'human' && !seat.connected && seat.userId) {
        const uid = seat.userId;
        seat.disconnectDeadline = null;
        this.lobbyGrace.set(
          uid,
          this.s.setTimeout(() => {
            this.lobbyGrace.delete(uid);
            const j = this.seatOf(uid);
            if (j === -1 || this.seats[j].connected || this.inMatch) return;
            this.removeHuman(j);
          }, LOBBY_DISCONNECT_GRACE_MS),
        );
      }
    }
  }

  // ------------------------------------------------------------------ teardown

  destroy(): void {
    if (this.destroyed) return;
    this.clearTimer();
    this.stopLoop();
    this.cancelQuickTimer();
    this.s.clearTimeout(this.graceTimer);
    this.graceTimer = null;
    for (const h of this.lobbyGrace.values()) this.s.clearTimeout(h);
    this.lobbyGrace.clear();
    this.destroyed = true;
    this.log('closed');
    this.deps.onEmpty();
  }

  /** Test helper: participants snapshot. */
  getParticipants(): Participant[] {
    return [...this.participants.values()].map((p) => ({ ...p }));
  }
}
