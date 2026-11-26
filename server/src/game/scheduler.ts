/** Time + timers abstraction so Room logic can be driven deterministically in tests. */
export type TimerHandle = { readonly __timer: true } | object;

export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle | null | undefined): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(h: TimerHandle | null | undefined): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => {
    if (h) clearTimeout(h as NodeJS.Timeout);
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => {
    if (h) clearInterval(h as NodeJS.Timeout);
  },
};

interface ManualTask {
  id: number;
  at: number;
  fn: () => void;
  every: number | null;
}

/** Virtual clock for tests: nothing runs until advance() is called. */
export class ManualScheduler implements Scheduler {
  private time: number;
  private seq = 0;
  private tasks = new Map<number, ManualTask>();

  constructor(start = 1_000_000) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.tasks.set(id, { id, at: this.time + Math.max(0, ms), fn, every: null });
    return { id };
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    const every = Math.max(1, ms);
    this.tasks.set(id, { id, at: this.time + every, fn, every });
    return { id };
  }

  clearTimeout(h: TimerHandle | null | undefined): void {
    if (h) this.tasks.delete((h as { id: number }).id);
  }

  clearInterval(h: TimerHandle | null | undefined): void {
    this.clearTimeout(h);
  }

  /** Number of pending timers (for leak checks). */
  get pending(): number {
    return this.tasks.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: ManualTask | null = null;
      for (const t of this.tasks.values()) {
        if (t.at <= target + 1e-9 && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      }
      if (!next) break;
      this.time = Math.max(this.time, next.at);
      if (next.every !== null) next.at += next.every;
      else this.tasks.delete(next.id);
      next.fn();
    }
    this.time = target;
  }
}
