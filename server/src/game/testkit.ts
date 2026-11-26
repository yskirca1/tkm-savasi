// Test helpers (imported only by *.test.ts): controllable fake physics + fake transport.
import { SPECIES, SPECIES_INDEX, type Species } from '@tkm/shared';
import type { SimApi, SimState } from '../sim/api.js';
import { sim as realSim } from '../sim/index.js';
import type { MatchRecord } from '../db/types.js';
import type { EventPayload, ServerEvent } from './Room.js';
import { RoomManager, type Transport } from './RoomManager.js';
import { ManualScheduler } from './scheduler.js';

/** Real pure rules (pickOrder, evaluateVote, …) + fake physics whose species counts the test controls. */
export class FakePhysics {
  counts: [number, number, number] = [4, 4, 4];
  state: SimState | null = null;

  setCounts(c: [number, number, number]): void {
    this.counts = c;
    if (this.state) this.state.units = this.unitsFor(c);
  }

  private unitsFor(c: [number, number, number]) {
    const units: SimState['units'] = [];
    c.forEach((n, i) => {
      for (let k = 0; k < n; k++) units.push({ x: 10 + k, y: 10 + i, vx: 90, vy: 0, species: SPECIES[i] });
    });
    return units;
  }

  readonly api: SimApi = {
    ...realSim,
    createRound: (seed: number, unitsPerType: number): SimState => {
      this.counts = [unitsPerType, unitsPerType, unitsPerType];
      this.state = {
        seed,
        map: realSim.generateMap(seed), // same map the real sim would build (preview == round map)
        units: this.unitsFor(this.counts),
        tick: 0,
        convertedSinceDrain: [],
      };
      return this.state;
    },
    tickSim: (state: SimState) => {
      state.tick += 1;
      const counts = realSim.speciesCounts(state);
      const alive = SPECIES.filter((s) => counts[SPECIES_INDEX[s]] > 0);
      return { counts, soleSurvivor: alive.length === 1 ? (alive[0] as Species) : null };
    },
  };
}

export interface SentEvent {
  to: string; // 'room:CODE' | 'user:ID'
  event: ServerEvent;
  payload: unknown;
}

export class FakeTransport implements Transport {
  sent: SentEvent[] = [];
  channels = new Map<string, Set<string>>(); // userId -> codes
  online = new Set<string>();

  emitToRoom<E extends ServerEvent>(code: string, event: E, payload: EventPayload<E>): void {
    this.sent.push({ to: `room:${code}`, event, payload: structuredClone(payload) });
  }
  emitToUser<E extends ServerEvent>(userId: string, event: E, payload: EventPayload<E>): void {
    this.sent.push({ to: `user:${userId}`, event, payload: structuredClone(payload) });
  }
  joinChannel(userId: string, code: string): void {
    if (!this.channels.has(userId)) this.channels.set(userId, new Set());
    this.channels.get(userId)!.add(code);
  }
  leaveChannel(userId: string, code: string): void {
    this.channels.get(userId)?.delete(code);
  }
  isOnline(userId: string): boolean {
    return this.online.has(userId);
  }

  of<E extends ServerEvent>(event: E): EventPayload<E>[] {
    return this.sent.filter((e) => e.event === event).map((e) => e.payload as EventPayload<E>);
  }
  last<E extends ServerEvent>(event: E): EventPayload<E> | undefined {
    const all = this.of(event);
    return all[all.length - 1];
  }
  clear(): void {
    this.sent = [];
  }
}

/** Deterministic PRNG for tests. */
export function seededRandom(seed = 12345): () => number {
  return realSim.createRng(seed);
}

export const USERS = {
  a: { userId: 'u-a', username: 'Ayse', avatarUrl: null },
  b: { userId: 'u-b', username: 'Burak', avatarUrl: null },
  c: { userId: 'u-c', username: 'Cem', avatarUrl: null },
  d: { userId: 'u-d', username: 'Deniz', avatarUrl: null },
} as const;

export function setup(opts: { sim?: SimApi; seed?: number; unitsPerType?: number } = {}) {
  const physics = new FakePhysics();
  const sched = new ManualScheduler();
  const transport = new FakeTransport();
  const saved: MatchRecord[] = [];
  const logs: string[] = [];
  const mgr = new RoomManager({
    sim: opts.sim ?? physics.api,
    scheduler: sched,
    transport,
    unitsPerType: opts.unitsPerType ?? 4,
    random: seededRandom(opts.seed ?? 12345),
    saveMatch: async (m) => {
      saved.push(m);
    },
    log: (m) => logs.push(m),
  });
  return { physics, sched, transport, saved, logs, mgr };
}
