// Visual effects: unit conversion pops and the 5x "fever" fire along the screen edges.

export const CONVERT_MS = 450;

/** Tracks per-unit conversion animation start times. */
export class ConversionFx {
  private starts = new Map<number, number>();

  add(indices: number[], now: number): void {
    for (const i of indices) this.starts.set(i, now);
  }
  clear(): void {
    this.starts.clear();
  }
  /** 0..1 progress for unit i, or -1 if not animating. */
  progress(i: number, now: number): number {
    const s = this.starts.get(i);
    if (s === undefined) return -1;
    const p = (now - s) / CONVERT_MS;
    if (p >= 1) {
      this.starts.delete(i);
      return -1;
    }
    return p;
  }
  get active(): boolean {
    return this.starts.size > 0;
  }
}

/** Pop curve: quick overshoot then settle (1 → 1.55 → 1). */
export function popScale(p: number): number {
  if (p < 0) return 1;
  if (p < 0.35) return 1 + 0.55 * (p / 0.35);
  return 1 + 0.55 * (1 - easeOutCubic((p - 0.35) / 0.65));
}
export function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  sprite: number;
}

/** Fire particles spawned along the edges of a transparent overlay canvas. */
export class FireFx {
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private sprites: HTMLCanvasElement[];
  private raf = 0;
  private last = 0;
  private running = false;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private acc = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.sprites = ['#FDE68A', '#FB923C', '#EF4444'].map((c) => blob(c));
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.step(Math.min(0.05, (now - this.last) / 1000));
      this.last = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.particles = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private spawn(): void {
    const { w, h } = this;
    const perim = 2 * (w + h);
    let d = Math.random() * perim;
    let x: number, y: number, nx: number, ny: number;
    if (d < w) {
      x = d; y = h; nx = 0; ny = -1; // bottom: flames rise
    } else if ((d -= w) < w) {
      x = d; y = 0; nx = 0; ny = 1;
    } else if ((d -= w) < h) {
      x = 0; y = d; nx = 1; ny = 0;
    } else {
      d -= h; x = w; y = d; nx = -1; ny = 0;
    }
    const base = Math.min(w, h);
    const speed = base * (0.05 + Math.random() * 0.08);
    const max = 0.55 + Math.random() * 0.6;
    this.particles.push({
      x: x + (Math.random() - 0.5) * 6,
      y: y + (Math.random() - 0.5) * 6,
      vx: nx * speed + (Math.random() - 0.5) * 20,
      vy: ny * speed - base * 0.04, // everything drifts upward a little
      life: max,
      max,
      size: Math.max(14, base * (0.035 + Math.random() * 0.045)),
      sprite: Math.random() < 0.3 ? 0 : Math.random() < 0.6 ? 1 : 2,
    });
  }

  private step(dt: number): void {
    const rate = Math.min(260, (2 * (this.w + this.h)) / 6); // particles per second
    this.acc += rate * dt;
    while (this.acc > 1 && this.particles.length < 240) {
      this.spawn();
      this.acc -= 1;
    }
    if (this.acc > 1) this.acc = 0;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'lighter';
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      if (p.life <= 0) {
        ps[i] = ps[ps.length - 1];
        ps.pop();
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const k = p.life / p.max;
      const s = p.size * (0.45 + 0.55 * k);
      ctx.globalAlpha = Math.min(1, k * 1.4) * 0.8;
      ctx.drawImage(this.sprites[p.sprite], p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

function blob(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, '#FFFFFF');
  grad.addColorStop(0.25, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}
