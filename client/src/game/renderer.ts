// Canvas renderer: static map layer (night floor, clay obstacles if any) + bare emoji unit sprites + conversion effects.
// Units are drawn as the emoji only (no disc/ring): the visible glyph spans the hitbox diameter (2 x UNIT_RADIUS).
import { GRID_CELL, SPECIES_EMOJI, UNIT_RADIUS, WORLD_HEIGHT, WORLD_WIDTH, type MapData, type Rect, type Species } from '@tkm/shared';
import { reducedMotion } from '../settings';
import { SPECIES_BY_INDEX } from '../theme';
import { ConversionFx, popScale } from './effects';
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
    // Fits by width or height, whichever limits (works for any world aspect, portrait or landscape).
    const k = Math.max(40 / Math.max(WORLD_WIDTH, WORLD_HEIGHT), Math.min(availW / WORLD_WIDTH, availH / WORLD_HEIGHT));
    const w = Math.floor(WORLD_WIDTH * k);
    const h = Math.floor(WORLD_HEIGHT * k);
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
    const pad = Math.ceil(r * 0.3); // room for the soft drop shadow
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

    // Floor: deep night indigo with a low-contrast checker of grid cells.
    g.fillStyle = '#17142E';
    g.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    g.fillStyle = '#1D1939';
    for (let y = 0; y < WORLD_HEIGHT; y += GRID_CELL) {
      for (let x = (y / GRID_CELL) % 2 ? GRID_CELL : 0; x < WORLD_WIDTH; x += GRID_CELL * 2) g.fillRect(x, y, GRID_CELL, GRID_CELL);
    }
    // Inner wall shadow (outer walls are the world boundary).
    const edge = g.createLinearGradient(0, 0, 0, 18);
    edge.addColorStop(0, 'rgba(0,0,0,0.4)');
    edge.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = edge;
    g.fillRect(0, 0, WORLD_WIDTH, 18);
    const edgeL = g.createLinearGradient(0, 0, 14, 0);
    edgeL.addColorStop(0, 'rgba(0,0,0,0.3)');
    edgeL.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = edgeL;
    g.fillRect(0, 0, 14, WORLD_HEIGHT);

    for (const o of this.map?.obstacles ?? []) drawClayBlock(g, o);
  }

  /** Map only (floor, walls, obstacles). */
  drawStatic(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.drawImage(this.staticLayer, 0, 0);
  }

  /**
   * Static starting layout for the picking-screen preview: the map plus every unit as its in-game
   * sprite. `units` is the flat [x, y, s, ...] wire format (same as GameSnapshot.units).
   */
  drawLayout(units: readonly number[]): void {
    this.drawStatic();
    if (!this.sprites.length) return;
    const k = this.scale * this.dpr;
    const base = this.spriteSize();
    for (let i = 0; i + 2 < units.length; i += 3) {
      const spr = this.sprites[units[i + 2]];
      if (spr) this.ctx.drawImage(spr, units[i] * k - base / 2, units[i + 1] * k - base / 2, base, base);
    }
  }

  /** Drawn sprite size in device px (sprites are rasterised SPRITE_OVERSAMPLE x larger). */
  private spriteSize(): number {
    return this.sprites[0].width / SPRITE_OVERSAMPLE;
  }

  draw(sample: Sample | null, fx: ConversionFx, now: number): void {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.staticLayer, 0, 0);
    if (!sample || !this.sprites.length) return;
    const k = this.scale * this.dpr;
    const base = this.spriteSize();
    const popping: { x: number; y: number; p: number; s: number }[] = [];
    for (let i = 0; i < sample.n; i++) {
      const p = fx.progress(i, now);
      if (p >= 0) {
        popping.push({ x: sample.x[i] * k, y: sample.y[i] * k, p, s: sample.s[i] });
        continue; // drawn on top later
      }
      const spr = this.sprites[sample.s[i]];
      ctx.drawImage(spr, sample.x[i] * k - base / 2, sample.y[i] * k - base / 2, base, base);
    }
    // Converting units: no ring/disc — the new emoji itself pops (1 → 1.35 → 1) and briefly flashes brighter.
    const still = reducedMotion();
    for (const u of popping) {
      const spr = this.sprites[u.s];
      const s = still ? base : base * popScale(u.p);
      const x = u.x - s / 2;
      const y = u.y - s / 2;
      ctx.drawImage(spr, x, y, s, s);
      if (u.p < 0.5) {
        // Additive redraw of the glyph only (transparent sprite pixels add nothing), so the flash is emoji-shaped.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.55 * (1 - u.p / 0.5);
        ctx.drawImage(spr, x, y, s, s);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }
}

/** Ink bounds of an emoji glyph relative to its center/middle anchor, in units of font size. */
interface GlyphInk { x0: number; y0: number; x1: number; y1: number }
const inkCache = new Map<string, GlyphInk>();

/**
 * Emoji fonts report the full em box from measureText (the same for every glyph), so the actual drawn
 * shape is measured by rasterising once and scanning alpha. Cached per glyph; size-independent ratios.
 */
function glyphInk(glyph: string): GlyphInk {
  const hit = inkCache.get(glyph);
  if (hit) return hit;
  const REF = 128;
  const N = REF * 2;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.font = `${REF}px ${EMOJI_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(glyph, N / 2, N / 2);
  const a = g.getImageData(0, 0, N, N).data;
  let x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (a[(y * N + x) * 4 + 3] > 40) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  // Fallback (nothing drawn, e.g. fonts unavailable): assume ink ≈ 0.86 of the em box.
  const ink: GlyphInk =
    x1 < 0
      ? { x0: -0.43, y0: -0.43, x1: 0.43, y1: 0.43 }
      : { x0: (x0 - N / 2) / REF, y0: (y0 - N / 2) / REF, x1: (x1 + 1 - N / 2) / REF, y1: (y1 + 1 - N / 2) / REF };
  if (x1 >= 0) inkCache.set(glyph, ink);
  return ink;
}

function makeSprite(sp: Species, size: number, r: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const glyph = SPECIES_EMOJI[sp];
  // Size the font so the *visible* glyph (its ink, not the em box) spans the hitbox diameter 2r, centred.
  const ink = glyphInk(glyph);
  const fontPx = (r * 2) / Math.max(ink.x1 - ink.x0, ink.y1 - ink.y0);
  const x = size / 2 - ((ink.x0 + ink.x1) / 2) * fontPx;
  const y = size / 2 - ((ink.y0 + ink.y1) / 2) * fontPx;
  // Bare emoji on the dark floor: only a soft dark drop shadow (no disc, no ring).
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = r * 0.16;
  g.shadowOffsetY = r * 0.07;
  g.font = `${fontPx}px ${EMOJI_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(glyph, x, y);
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

/** Chunky clay obstacle (night): dark drop shadow, glowing violet body, light outline, bright top edge. */
function drawClayBlock(g: CanvasRenderingContext2D, o: Rect): void {
  const inset = 2;
  const x = o.x + inset;
  const y = o.y + inset;
  const w = o.w - inset * 2;
  const h = o.h - inset * 2;
  const r = Math.min(10, Math.min(w, h) * 0.35);
  roundRect(g, x + 1, y + 5, w, h, r);
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fill();
  roundRect(g, x, y, w, h, r);
  const grad = g.createLinearGradient(0, y, 0, y + h);
  grad.addColorStop(0, '#7C6AE6');
  grad.addColorStop(1, '#4B3AA8');
  g.fillStyle = grad;
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = '#A99BF5';
  g.stroke();
  roundRect(g, x + 4, y + 3.5, Math.max(0, w - 8), Math.min(5, h * 0.18), 3);
  g.fillStyle = 'rgba(255,255,255,0.4)';
  g.fill();
}
