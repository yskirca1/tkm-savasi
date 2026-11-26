import type { Server, Socket } from 'socket.io';
import {
  ROUND_OPTIONS,
  SPECIES,
  type ClientToServerEvents,
  type RoundOption,
  type ServerToClientEvents,
  type Species,
} from '@tkm/shared';
import { GuestAuth, isGuestUserId } from '../auth/guest.js';
import type { AuthProvider } from '../auth/types.js';
import type { Store } from '../db/types.js';
import { MSG } from '../errors.js';
import type { RoomManager, Transport } from './RoomManager.js';
import type { RoomUser } from './Room.js';

export interface SocketData {
  userId: string;
  username: string;
  avatarUrl: string | null;
}

export type GameServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const userChannel = (userId: string) => `user:${userId}`;
const roomChannel = (code: string) => `room:${code}`;

/** Socket.IO-backed Transport for RoomManager. */
export function createSocketTransport(io: GameServer): Transport {
  return {
    emitToRoom: (code, event, payload) => {
      (io.to(roomChannel(code)) as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
    },
    emitToUser: (userId, event, payload) => {
      (io.to(userChannel(userId)) as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
    },
    joinChannel: (userId, code) => io.in(userChannel(userId)).socketsJoin(roomChannel(code)),
    leaveChannel: (userId, code) => io.in(userChannel(userId)).socketsLeave(roomChannel(code)),
    isOnline: (userId) => (io.sockets.adapter.rooms.get(userChannel(userId))?.size ?? 0) > 0,
  };
}

export function registerSocketHandlers(io: GameServer, deps: { auth: AuthProvider; guest: GuestAuth; store: Store; rooms: RoomManager }): void {
  const { auth, guest, store, rooms } = deps;

  // ---- handshake auth: socket.handshake.auth.token
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string' || !token) return next(new Error('unauthorized'));
      // Guests first: local check, no Store/profile lookup (never 'profil_gerekli').
      const g = await guest.verify(token);
      if (g) {
        socket.data = { userId: g.userId, username: g.name, avatarUrl: null };
        return next();
      }
      const user = await auth.verifyToken(token);
      if (!user) return next(new Error('unauthorized'));
      const profile = await store.getProfile(user.userId);
      if (!profile) return next(new Error('profil_gerekli'));
      socket.data = { userId: user.userId, username: profile.username, avatarUrl: profile.avatarUrl };
      next();
    } catch (err) {
      console.error('[socket] auth error:', err);
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: GameSocket) => {
    const { userId } = socket.data;
    socket.join(userChannel(userId));

    // auto re-attach (reconnect flow)
    rooms.handleConnect(userId);

    const fail = (message: string | undefined) => {
      if (message) socket.emit('error:msg', { message });
    };
    const currentUser = async (): Promise<RoomUser> => {
      // usernames can change (PATCH /api/profile): fetch fresh at join time. Guests have no profile.
      const p = isGuestUserId(userId) ? null : await store.getProfile(userId).catch(() => null);
      if (p) {
        socket.data.username = p.username;
        socket.data.avatarUrl = p.avatarUrl;
      }
      return { userId, username: socket.data.username, avatarUrl: socket.data.avatarUrl };
    };
    const safe =
      <A extends unknown[]>(fn: (...args: A) => unknown | Promise<unknown>) =>
      async (...args: A) => {
        try {
          await fn(...args);
        } catch (err) {
          console.error(`[socket] handler error (${userId}):`, err);
          fail(MSG.server);
        }
      };

    socket.on(
      'room:create',
      safe(async (p, ack) => {
        const user = await currentUser();
        const tr = p?.totalRounds;
        const rounds = typeof tr === 'number' && (ROUND_OPTIONS as readonly number[]).includes(tr) ? (tr as RoundOption) : undefined;
        const { code } = rooms.createRoom(user, rounds);
        if (typeof ack === 'function') ack({ ok: true, code });
      }),
    );

    socket.on(
      'room:join',
      safe(async (p, ack) => {
        const user = await currentUser();
        const res = rooms.joinRoom(user, String(p?.code ?? ''));
        if (typeof ack === 'function') ack(res);
        else if (!res.ok) fail(res.error);
      }),
    );

    socket.on(
      'room:quick',
      safe(async (_p, ack) => {
        const user = await currentUser();
        const res = rooms.quickMatch(user);
        if (typeof ack === 'function') ack(res);
        else if (!res.ok) fail(res.error);
      }),
    );

    socket.on(
      'room:practice',
      safe(async (_p, ack) => {
        const user = await currentUser();
        const { code } = rooms.practice(user);
        if (typeof ack === 'function') ack({ ok: true, code });
      }),
    );

    socket.on('room:leave', safe(() => rooms.leave(userId)));

    socket.on(
      'room:setRounds',
      safe((p) => fail(rooms.withRoom(userId, (r) => r.setRounds(userId, Number(p?.totalRounds))))),
    );

    socket.on('room:startWithBot', safe(() => fail(rooms.withRoom(userId, (r) => r.startWithBot(userId)))));

    socket.on(
      'pick:choose',
      safe((p) => {
        const sp = p?.species as Species;
        if (!SPECIES.includes(sp)) return fail(MSG.badRequest);
        fail(rooms.withRoom(userId, (r) => r.choose(userId, sp)));
      }),
    );

    socket.on(
      'vote:set',
      safe((p) => {
        rooms.withRoom(userId, (r) => r.vote(userId, p?.approve === true));
      }),
    );

    socket.on('match:rematch', safe(() => fail(rooms.withRoom(userId, (r) => r.rematch(userId)))));

    socket.on('disconnect', () => {
      const left = io.sockets.adapter.rooms.get(userChannel(userId))?.size ?? 0;
      if (left === 0) rooms.handleDisconnect(userId);
    });
  });
}
