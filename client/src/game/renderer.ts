// Canvas renderer: static map layer (floor, clay obstacles) + bare emoji unit sprites + conversion effects.
// Units are drawn as the emoji only (no disc/ring), sized to the hitbox diameter (2 x UNIT_RADIUS).
import { GRID_CELL, SPECIES_EMOJI, UNIT_RADIUS, WORLD_HEIGHT, WORLD_WIDTH, type MapData, type Rect, type Species } from '@tkm/shared';
import { SPECIES_BY_INDEX, SPECIES_COLOR } from '../theme';
import { ConversionFx, easeOutCubic, popScale } from './effects';
import type { Sample } from './interp';

const EMOJI_FONT = `'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji','Twemoji Mozilla',sans-serif`;
/** Sprites are rendered larger than their on-screen size so the conversion pop stays crisp. */
const SPRITE_OVERSAMPLE = 1.6;

export class GameRenderer {
  private ctx: CanvasRenderingContext2D;
  private map: MapData | null = null;
  private staticLayer: HTMLCanvasElement = document.createElement('canvas');
  private sprites: HTMLCanvasElement[] = [];
  /** CSS px per world unit. */
  private scale = 1;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  setMap(map: MapData | null): void {
    this.map = map;
    this.buildStatic();
  }

  /** Fit the world into (availW, availH) CSS px preserving aspect. Returns the canvas CSS size. */
  fit(availW: number, availH: number): { w: number; h: number } {
    const aspect = WORLD_WIDTH / WORLD_HEIGHT;
    let w = Math.max(60, availW);
    let h = w / aspect;
    if (h > availH && availH > 120) {
      h = availH;
      w = h * aspect;
    }
    w = Math.floor(w);
    h = Math.floor(w / aspect);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return { w, h };
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.scale = w / WORLD_WIDTH;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.buildSprites();
    this.buildStatic();
    return { w, h };
  }

  private buildSprites(): void {
    // r = hitbox radius in device px (never below ~6 CSS px so units stay legible on small phones).
    const r = Math.max(UNIT_RADIUS * this.scale, 6) * this.dpr * SPRITE_OVERSAMPLE;
    const pad = Math.ceil(r * 0.2);
    const size = Math.ceil(r * 2 + pad * 2);
    this.sprites = SPECIES_BY_INDEX.map((sp) => makeSprite(sp, size, r));
  }

  private buildStatic(): void {
    const c = this.staticLayer;
    c.width = this.canvas.width || 1;
    c.height = this.canvas.height || 1;
    const g = c.getContext('2d')!;
    const k = this.scale * this.dpr;
    g.setTransform(k, 0, 0, k, 0, 0);

    // Floor: warm cream with soft checker of grid cells.
    g.fillStyle = '#FFF8F1';
    g.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    g.fillStyle = '#FDEFE3';
    for (let y = 0; y < WORLD_HEIGHT; y += GRID_CELL) {
      for (let x = (y / GRID_CELL) % 2 ? GRID_CELL : 0; x < WORLD_WIDTH; x += GRID_CELL * 2) g.fillRect(x, y, GRID_CELL, GRID_CELL);
    }
    // Inner wall shadow (outer walls are the world boundary).
    const edge = g.createLinearGradient(0, 0, 0, 18);
    edge.addColorStop(0, 'rgba(30,27,75,0.16)');
    edge.addColorStop(1, 'rgba(30,27,75,0)');
    g.fillStyle = edge;
    g.fillRect(0, 0, WORLD_WIDTH, 18);
    const edgeL = g.createLinearGradient(0, 0, 14, 0);
    edgeL.addColorStop(0, 'rgba(30,27,75,0.12)');
    edgeL.addColorStop(1, 'rgba(30,27,75,0)');
    g.fillStyle = edgeL;
    g.fillRect(0, 0, 14, WORLD_HEIGHT);

    for (const o of this.map?.obstacles ?? []) drawClayBlock(g, o);
  }

  /** Map only (floor, walls, obstacles) — used for the picking-screen preview. */
  drawStatic(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.staticLayer, 0, 0);
  }

  draw(sample: Sample | null, fx: ConversionFx, now: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticLayer, 0, 0);
    if (!sample || !this.sprites.length) return;
    const k = this.scale * this.dpr;
    const base = this.sprites[0].width / SPRITE_OVERSAMPLE;
    const rings: { x: number; y: number; p: number; s: number }[] = [];
    for (let i = 0; i < sample.n; i++) {
      const p = fx.progress(i, now);
      if (p >= 0) {
        rings.push({ x: sample.x[i] * k, y: sample.y[i] * k, p, s: sample.s[i] });
        continue; // drawn on top later
      }
      const spr = this.sprites[sample.s[i]];
      ctx.drawImage(spr, sample.x[i] * k - base / 2, sample.y[i] * k - base / 2, base, base);
    }
    // Converting units: brief fading flash ring in the new color + pop; once done, the plain emoji again.
    for (const r of rings) {
      const color = SPECIES_COLOR[SPECIES_BY_INDEX[r.s]].main;
      const ringR = (UNIT_RADIUS * (1.2 + 1.8 * easeOutCubic(r.p))) * k;
      ctx.globalAlpha = 1 - r.p;
      ctx.lineWidth = Math.max(2, 4 * k * (1 - r.p));
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(r.x, r.y, ringR, 0, Math.PI * 2);
      ctx.stroke();
      if (r.p < 0.3) {
        ctx.globalAlpha = 0.5 * (1 - r.p / 0.3);
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(r.x, r.y, UNIT_RADIUS * 1.4 * k, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      const s = base * popScale(r.p);
      ctx.drawImage(this.sprites[r.s], r.x - s / 2, r.y - s / 2, s, s);
    }
  }
}

function makeSprite(sp: Species, size: number, r: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const cx = size / 2;
  const cy = size / 2;
  // Bare emoji, glyph ≈ hitbox diameter. A soft blur shadow (not a disc) keeps it readable on the floor.
  g.shadowColor = 'rgba(30,27,75,0.28)';
  g.shadowBlur = r * 0.18;
  g.shadowOffsetY = r * 0.08;
  g.font = `${Math.round(r * 1.75)}px ${EMOJI_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(SPECIES_EMOJI[sp], cx, cy + r * 0.08);
  return c;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Chunky clay obstacle: bottom shadow, lavender body, thick outline, top highlight. */
function drawClayBlock(g: CanvasRenderingContext2D, o: Rect): void {
  const inset = 2;
  const x = o.x + inset;
  const y = o.y + inset;
  const w = o.w - inset * 2;
  const h = o.h - inset * 2;
  const r = Math.min(10, Math.min(w, h) * 0.35);
  roundRect(g, x + 1, y + 5, w, h, r);
  g.fillStyle = 'rgba(30,27,75,0.22)';
  g.fill();
  roundRect(g, x, y, w, h, r);
  const grad = g.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, '#DDD6FE');
  grad.addColorStop(1, '#A78BFA');
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = '#4C1D95';
  g.stroke();
  roundRect(g, x + 4, y + 3.5, Math.max(0, w - 8), Math.min(5, h * 0.18), 3);
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.fill();
}
