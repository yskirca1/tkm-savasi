// Single socket store. All room/game state from the server flows through here.
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  GameSnapshot,
  MatchEnd,
  PickState,
  RoomState,
  RoundEnd,
  RoundOption,
  RoundStart,
  ServerToClientEvents,
  Species,
} from '@tkm/shared';
import { getToken } from './auth';
import { Emitter } from './dom';
import { toast } from './toast';

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface NetState {
  status: ConnStatus;
  room: RoomState | null;
  /** performance.now() when the latest room:state arrived (for the quick-match local countdown). */
  roomAt: number;
  pick: PickState | null;
  /** performance.now() when pick arrived (for local countdown). */
  pickAt: number;
  roundStart: RoundStart | null;
  roundStartAt: number;
  snapshot: GameSnapshot | null;
  roundEnd: RoundEnd | null;
  roundEndAt: number;
  matchEnd: MatchEnd | null;
}

type Events = {
  change: NetState;
  room: RoomState;
  pick: PickState;
  roundStart: RoundStart;
  snapshot: GameSnapshot;
  roundEnd: RoundEnd;
  matchEnd: MatchEnd;
  status: ConnStatus;
  profileRequired: void;
  authFailed: void;
  reconnected: void;
};

export const state: NetState = {
  status: 'idle',
  room: null,
  roomAt: 0,
  pick: null,
  pickAt: 0,
  roundStart: null,
  roundStartAt: 0,
  snapshot: null,
  roundEnd: null,
  roundEndAt: 0,
  matchEnd: null,
};

export const netEvents = new Emitter<Events>();
let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let everConnected = false;
let dismissConnToast: (() => void) | null = null;

function changed(): void {
  netEvents.emit('change', state);
}

function setStatus(s: ConnStatus): void {
  state.status = s;
  netEvents.emit('status', s);
  if (s === 'disconnected' && everConnected && !dismissConnToast) {
    dismissConnToast = toast('Connection lost, reconnecting…', 'error', 0);
  }
  if (s === 'connected' && dismissConnToast) {
    dismissConnToast();
    dismissConnToast = null;
    toast('Reconnected', 'success', 2000);
  }
}

export function resetRoomState(): void {
  state.room = null;
  state.pick = null;
  state.roundStart = null;
  state.snapshot = null;
  state.roundEnd = null;
  state.matchEnd = null;
  changed();
}

/** Connect (idempotent). The auth callback fetches a fresh token on every (re)connect attempt. */
export function connect(): void {
  if (socket) {
    if (!socket.connected && !socket.active) socket.connect();
    return;
  }
  setStatus('connecting');
  socket = io({
    auth: (cb) => {
      getToken()
        .then((token) => cb({ token: token ?? '' }))
        .catch(() => cb({ token: '' }));
    },
    transports: ['websocket', 'polling'],
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
  });

  socket.on('connect', () => {
    const wasReconnect = everConnected;
    everConnected = true;
    setStatus('connected');
    if (wasReconnect) netEvents.emit('reconnected', undefined);
  });
  socket.on('disconnect', (reason) => {
    setStatus('disconnected');
    // Server-initiated disconnects are not retried automatically by socket.io.
    if (reason === 'io server disconnect') setTimeout(() => socket?.connect(), 1000);
  });
  socket.on('connect_error', (err) => {
    const msg = err?.message ?? '';
    if (msg === 'profil_gerekli') {
      socket?.disconnect();
      netEvents.emit('profileRequired', undefined);
      return;
    }
    if (/auth|token|yetki|unauthor|oturum/i.test(msg)) {
      // Token likely expired: force refresh before the next attempt; give up if no session.
      getToken(true).then((t) => {
        if (!t) {
          socket?.disconnect();
          netEvents.emit('authFailed', undefined);
        }
      });
    }
    setStatus('disconnected');
  });

  socket.on('room:state', (s) => {
    const prevPhase = state.room?.phase;
    state.room = s;
    state.roomAt = performance.now();
    if (s.phase === 'lobby') {
      state.pick = null;
      state.roundStart = null;
      state.snapshot = null;
      state.roundEnd = null;
      state.matchEnd = null;
    }
    if (s.phase === 'picking' && prevPhase !== 'picking') {
      state.roundEnd = null;
      state.snapshot = null;
    }
    netEvents.emit('room', s);
    changed();
  });
  socket.on('pick:state', (p) => {
    state.pick = p;
    state.pickAt = performance.now();
    netEvents.emit('pick', p);
    changed();
  });
  socket.on('round:start', (r) => {
    state.roundStart = r;
    state.roundStartAt = performance.now();
    state.snapshot = null;
    state.roundEnd = null;
    netEvents.emit('roundStart', r);
    changed();
  });
  socket.on('game:snapshot', (s) => {
    state.snapshot = s;
    // Hot path: no 'change' emit (DOM views subscribe to 'snapshot' and update cheaply).
    netEvents.emit('snapshot', s);
  });
  socket.on('round:end', (r) => {
    state.roundEnd = r;
    state.roundEndAt = performance.now();
    if (state.room) state.room = { ...state.room, scores: r.scores };
    netEvents.emit('roundEnd', r);
    changed();
  });
  socket.on('match:end', (m) => {
    state.matchEnd = m;
    netEvents.emit('matchEnd', m);
    changed();
  });
  socket.on('error:msg', ({ message }) => toast(message, 'error'));
}

export function disconnect(): void {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
  everConnected = false;
  dismissConnToast?.();
  dismissConnToast = null;
  state.status = 'idle';
  resetRoomState();
}

type AckRes<T> = ({ ok: true } & T) | { ok: false; error: string };

function withAck<T>(fn: (s: NonNullable<typeof socket>, cb: (err: Error | null, res: AckRes<T>) => void) => void): Promise<AckRes<T>> {
  return new Promise((resolve) => {
    if (!socket) {
      resolve({ ok: false, error: 'You\'re not connected to the server.' });
      return;
    }
    fn(socket, (err, res) => {
      if (err) resolve({ ok: false, error: 'The server didn\'t respond. Try again.' });
      else resolve(res);
    });
  });
}

export const send = {
  createRoom: (totalRounds?: RoundOption) =>
    withAck<{ code: string }>((s, cb) => s.timeout(8000).emit('room:create', { totalRounds }, cb)),
  practice: () => withAck<{ code: string }>((s, cb) => s.timeout(8000).emit('room:practice', {}, cb)),
  quickMatch: () => withAck<{ code: string }>((s, cb) => s.timeout(8000).emit('room:quick', {}, cb)),
  joinRoom: (code: string) => withAck<{ code: string }>((s, cb) => s.timeout(8000).emit('room:join', { code }, cb)),
  leaveRoom: () => {
    socket?.emit('room:leave');
    resetRoomState();
  },
  setRounds: (totalRounds: RoundOption) => socket?.emit('room:setRounds', { totalRounds }),
  startWithBot: () => socket?.emit('room:startWithBot'),
  pick: (species: Species) => socket?.emit('pick:choose', { species }),
  vote: (approve: boolean) => socket?.emit('vote:set', { approve }),
  rematch: () => socket?.emit('match:rematch'),
};

export function isConnected(): boolean {
  return !!socket?.connected;
}

// Dev-only debugging hook (stripped from production builds): window.__tkm.{state, netEvents}
if (import.meta.env.DEV) (window as unknown as { __tkm: unknown }).__tkm = { state, netEvents };
