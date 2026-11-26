// Snapshot interpolation: render ~100 ms behind the newest snapshot, lerping each unit by array index.
import { TICK_MS, type GameSnapshot } from '@tkm/shared';

export const INTERP_DELAY_MS = 100;

interface Entry {
  snap: GameSnapshot;
  /** Server-side time of this snapshot (tick * TICK_MS). */
  t: number;
}

export interface Sample {
  n: number;
  x: Float32Array;
  y: Float32Array;
  s: Uint8Array;
  /** Server time being rendered. */
  t: number;
  elapsedMs: number;
}

export class SnapshotBuffer {
  private buf: Entry[] = [];
  /** local performance.now() minus server time (min-tracked). */
  private offset: number | null = null;
  private lastRenderT = -Infinity;
  private conversions: { t: number; indices: number[] }[] = [];
  readonly sample: Sample = { n: 0, x: new Float32Array(64), y: new Float32Array(64), s: new Uint8Array(64), t: 0, elapsedMs: 0 };

  reset(): void {
    this.buf = [];
    this.offset = null;
    this.lastRenderT = -Infinity;
    this.conversions = [];
    this.sample.n = 0;
  }

  get latest(): GameSnapshot | null {
    return this.buf.length ? this.buf[this.buf.length - 1].snap : null;
  }

  push(snap: GameSnapshot, now: number): void {
    const t = snap.tick * TICK_MS;
    const last = this.buf[this.buf.length - 1];
    if (last && t < last.t) this.reset(); // new round / server restart
    else if (last && t === last.t) {
      last.snap = snap;
      return;
    }
    const off = now - t;
    if (this.offset === null || off < this.offset || off - this.offset > 500) {
      // Large positive jump = we were paused (ticks frozen) → resync.
      if (this.offset !== null && off - this.offset > 500) this.lastRenderT = -Infinity;
      this.offset = off;
    } else {
      this.offset += (off - this.offset) * 0.02; // slow drift compensation
    }
    this.buf.push({ snap, t });
    if (this.buf.length > 40) this.buf.splice(0, this.buf.length - 40);
    if (snap.converted.length) this.conversions.push({ t, indices: snap.converted });
  }

  /** Interpolated unit state at `now` (performance.now()). Returns null if no data. */
  sampleAt(now: number): Sample | null {
    const b = this.buf;
    if (!b.length || this.offset === null) return null;
    let rt = now - this.offset - INTERP_DELAY_MS;
    if (rt < this.lastRenderT) rt = this.lastRenderT;
    this.lastRenderT = rt;

    let a = b[0];
    let c = b[0];
    let k = 0;
    if (rt >= b[b.length - 1].t) {
      a = c = b[b.length - 1];
    } else if (rt > b[0].t) {
      for (let i = 0; i < b.length - 1; i++) {
        if (b[i].t <= rt && rt < b[i + 1].t) {
          a = b[i];
          c = b[i + 1];
          k = (rt - a.t) / (c.t - a.t);
          break;
        }
      }
    }
    const ua = a.snap.units;
    const uc = c.snap.units;
    const n = Math.floor(uc.length / 3);
    const out = this.sample;
    if (out.x.length < n) {
      out.x = new Float32Array(n * 2);
      out.y = new Float32Array(n * 2);
      out.s = new Uint8Array(n * 2);
    }
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      const ax = ua.length > j ? ua[j] : uc[j];
      const ay = ua.length > j ? ua[j + 1] : uc[j + 1];
      out.x[i] = ax + (uc[j] - ax) * k;
      out.y[i] = ay + (uc[j + 1] - ay) * k;
      out.s[i] = ua.length > j ? ua[j + 2] : uc[j + 2];
    }
    out.n = n;
    out.t = rt;
    out.elapsedMs = a.snap.elapsedMs + (c.snap.elapsedMs - a.snap.elapsedMs) * k;
    return out;
  }

  /** Conversions whose snapshot time has now been reached by the render clock. */
  drainConversions(): number[] {
    const out: number[] = [];
    while (this.conversions.length && this.conversions[0].t <= this.lastRenderT) {
      out.push(...this.conversions.shift()!.indices);
    }
    return out;
  }
}
