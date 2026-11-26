import { DEFAULT_ROUNDS, ROUND_OPTIONS, type RoundOption } from '@tkm/shared';
import type { SimApi } from '../sim/api.js';
import type { MatchRecord } from '../db/types.js';
import { MSG } from '../errors.js';
import { Room, type ActionResult, type EventPayload, type Packet, type RoomUser, type ServerEvent } from './Room.js';
import type { Scheduler } from './scheduler.js';

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;

/** What the manager needs from the network layer (Socket.IO in prod, a fake in tests). */
export interface Transport {
  emitToRoom<E extends ServerEvent>(code: string, event: E, payload: EventPayload<E>): void;
  emitToUser<E extends ServerEvent>(userId: string, event: E, payload: EventPayload<E>): void;
  /** All sockets of the user join channel room:<code>. */
  joinChannel(userId: string, code: string): void;
  leaveChannel(userId: string, code: string): void;
  isOnline(userId: string): boolean;
}

export interface RoomManagerDeps {
  sim: SimApi;
  scheduler: Scheduler;
  transport: Transport;
  unitsPerType: number;
  random?: () => number;
  saveMatch?: (m: MatchRecord) => Promise<void>;
  log?: (msg: string) => void;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  readonly userRoom = new Map<string, string>();
  private random: () => number;

  constructor(private deps: RoomManagerDeps) {
    this.random = deps.random ?? Math.random;
  }

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < CODE_LENGTH; i++) c += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  roomOf(userId: string): Room | undefined {
    const code = this.userRoom.get(userId);
    return code ? this.rooms.get(code) : undefined;
  }

  private makeRoom(code: string, host: RoomUser, totalRounds: RoundOption): Room {
    const { transport } = this.deps;
    const room: Room = new Room(code, host, totalRounds, {
      sim: this.deps.sim,
      scheduler: this.deps.scheduler,
      random: this.random,
      unitsPerType: this.deps.unitsPerType,
      log: this.deps.log,
      emit: (event, payload) => transport.emitToRoom(code, event, payload),
      onMatchEnd: (record) => {
        const save = this.deps.saveMatch;
        if (!save) return;
        save(record).catch((err) => (this.deps.log ?? console.error)(`[room ${code}] saveMatch failed: ${String(err)}`));
      },
      onUserRemoved: (userId) => {
        if (this.userRoom.get(userId) === code) this.userRoom.delete(userId);
        transport.leaveChannel(userId, code);
      },
      onEmpty: () => {
        if (this.rooms.get(code) === room) this.rooms.delete(code);
        for (const [uid, c] of this.userRoom) if (c === code) this.userRoom.delete(uid);
      },
    });
    return room;
  }

  createRoom(user: RoomUser, totalRounds?: RoundOption): { code: string } {
    this.leave(user.userId);
    const rounds = totalRounds && (ROUND_OPTIONS as readonly number[]).includes(totalRounds) ? totalRounds : DEFAULT_ROUNDS;
    const code = this.newCode();
    const room = this.makeRoom(code, user, rounds);
    this.rooms.set(code, room);
    this.userRoom.set(user.userId, code);
    this.deps.transport.joinChannel(user.userId, code);
    room.emitState();
    return { code };
  }

  joinRoom(user: RoomUser, rawCode: string): { ok: true; code: string } | { ok: false; error: string } {
    const code = String(rawCode ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room || room.destroyed) return { ok: false, error: MSG.roomNotFound };

    if (room.hasUser(user.userId)) {
      // reconnect / second tab
      this.userRoom.set(user.userId, code);
      this.deps.transport.joinChannel(user.userId, code);
      room.userReconnected(user.userId);
      this.sync(user.userId);
      return { ok: true, code };
    }
    if (room.phase !== 'lobby') return { ok: false, error: MSG.gameStarted };
    if (room.humanCount() + room.seats.filter((s) => s.kind === 'bot').length >= 3) return { ok: false, error: MSG.roomFull };

    this.leave(user.userId);
    this.userRoom.set(user.userId, code);
    this.deps.transport.joinChannel(user.userId, code);
    const err = room.addHuman(user);
    if (err) {
      this.userRoom.delete(user.userId);
      this.deps.transport.leaveChannel(user.userId, code);
      return { ok: false, error: err };
    }
    return { ok: true, code };
  }

  leave(userId: string): void {
    const room = this.roomOf(userId);
    if (!room) {
      this.userRoom.delete(userId);
      return;
    }
    room.leave(userId);
    // leave() normally triggers onUserRemoved; make sure the mapping is gone either way
    if (this.userRoom.get(userId) === room.code) this.userRoom.delete(userId);
    this.deps.transport.leaveChannel(userId, room.code);
  }

  /** Called when the user's last socket disconnects. */
  handleDisconnect(userId: string): void {
    this.roomOf(userId)?.userDisconnected(userId);
  }

  /** Called when a user (re)connects: re-attach to the room they hold a seat in. Returns the room code. */
  handleConnect(userId: string): string | null {
    const room = this.roomOf(userId);
    if (!room) return null;
    if (!room.hasUser(userId)) {
      this.userRoom.delete(userId);
      return null;
    }
    this.deps.transport.joinChannel(userId, room.code);
    room.userReconnected(userId);
    this.sync(userId);
    return room.code;
  }

  /** Push full state to one user. */
  sync(userId: string): void {
    const room = this.roomOf(userId);
    if (!room) return;
    for (const p of room.syncPackets() as Packet[]) this.deps.transport.emitToUser(userId, p.event, p.payload as never);
  }

  renameUser(userId: string, username: string): void {
    this.roomOf(userId)?.renameUser(userId, username);
  }

  withRoom(userId: string, fn: (room: Room) => ActionResult): ActionResult {
    const room = this.roomOf(userId);
    if (!room) return MSG.notInRoom;
    return fn(room);
  }
}
