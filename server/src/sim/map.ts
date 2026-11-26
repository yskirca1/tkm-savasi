import { GRID_CELL, WORLD_HEIGHT, WORLD_WIDTH } from '@tkm/shared';
import type { MapData, Rect } from '@tkm/shared';
import { createRng, deriveSeed, randInt } from './rng.js';

export const COLS = Math.floor(WORLD_WIDTH / GRID_CELL); // 30
export const ROWS = Math.floor(WORLD_HEIGHT / GRID_CELL); // 20

/** Rasterize obstacles: a cell is blocked if its center lies inside any obstacle rect. */
export function blockedGrid(map: MapData): boolean[] {
  const cols = Math.floor(map.width / GRID_CELL);
  const rows = Math.floor(map.height / GRID_CELL);
  const grid = new Array<boolean>(cols * rows).fill(false);
  for (const o of map.obstacles) {
    for (let r = 0; r < rows; r++) {
      const cy = (r + 0.5) * GRID_CELL;
      if (cy < o.y || cy > o.y + o.h) continue;
      for (let c = 0; c < cols; c++) {
        const cx = (c + 0.5) * GRID_CELL;
        if (cx >= o.x && cx <= o.x + o.w) grid[r * cols + c] = true;
      }
    }
  }
  return grid;
}

/** 4-connectivity of all free cells in a cols x rows grid. */
export function gridConnected(grid: boolean[], cols: number, rows: number): boolean {
  let start = -1;
  let free = 0;
  for (let i = 0; i < grid.length; i++) {
    if (!grid[i]) {
      free++;
      if (start < 0) start = i;
    }
  }
  if (free === 0) return false;
  const seen = new Uint8Array(grid.length);
  const stack = [start];
  seen[start] = 1;
  let reached = 0;
  while (stack.length) {
    const i = stack.pop()!;
    reached++;
    const c = i % cols;
    const r = (i - c) / cols;
    const nb: number[] = [];
    if (c > 0) nb.push(i - 1);
    if (c < cols - 1) nb.push(i + 1);
    if (r > 0) nb.push(i - cols);
    if (r < rows - 1) nb.push(i + cols);
    for (const j of nb) {
      if (!grid[j] && !seen[j]) {
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  return reached === free;
}

export function isMapConnected(map: MapData): boolean {
  const cols = Math.floor(map.width / GRID_CELL);
  const rows = Math.floor(map.height / GRID_CELL);
  return gridConnected(blockedGrid(map), cols, rows);
}

/**
 * Random cell-aligned obstacles. Shapes: 1x1, 2x2, straight wall segments of 3–7 cells.
 * Rules: 1-cell free margin along the outer walls; every obstacle keeps a ≥1-cell gap
 * (8-neighbourhood) to every other obstacle, so obstacles never touch (no seams, every
 * corridor ≥ GRID_CELL wide > unit diameter); free cells stay 4-connected (checked by
 * flood fill, candidate skipped otherwise). Target ≈ 8–16% of cells blocked.
 */
export function generateMap(seed: number): MapData {
  const rng = createRng(deriveSeed(seed, 1));
  const cols = COLS;
  const rows = ROWS;
  const grid = new Array<boolean>(cols * rows).fill(false);
  const obstacles: Rect[] = [];
  const total = cols * rows;
  const target = Math.round(total * (0.09 + rng() * 0.06)); // 9%..15%
  let blocked = 0;

  const fits = (c0: number, r0: number, w: number, h: number): boolean => {
    // interior only: keep cols 0 / cols-1 and rows 0 / rows-1 free
    if (c0 < 1 || r0 < 1 || c0 + w > cols - 1 || r0 + h > rows - 1) return false;
    // no existing blocked cell within the shape expanded by 1 cell (8-neighbourhood gap)
    for (let r = r0 - 1; r <= r0 + h; r++) {
      for (let c = c0 - 1; c <= c0 + w; c++) {
        if (grid[r * cols + c]) return false;
      }
    }
    return true;
  };
  const setCells = (c0: number, r0: number, w: number, h: number, v: boolean) => {
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) grid[r * cols + c] = v;
  };

  for (let attempt = 0; attempt < 600 && blocked < target; attempt++) {
    const kind = rng();
    let w: number;
    let h: number;
    if (kind < 0.25) {
      w = h = 1;
    } else if (kind < 0.45) {
      w = h = 2;
    } else {
      const len = randInt(rng, 3, 7);
      if (rng() < 0.5) {
        w = len;
        h = 1;
      } else {
        w = 1;
        h = len;
      }
    }
    const c0 = randInt(rng, 1, cols - 1 - w);
    const r0 = randInt(rng, 1, rows - 1 - h);
    if (!fits(c0, r0, w, h)) continue;
    if (blocked + w * h > Math.round(total * 0.16)) continue;
    setCells(c0, r0, w, h, true);
    if (!gridConnected(grid, cols, rows)) {
      setCells(c0, r0, w, h, false);
      continue;
    }
    blocked += w * h;
    obstacles.push({ x: c0 * GRID_CELL, y: r0 * GRID_CELL, w: w * GRID_CELL, h: h * GRID_CELL });
  }
  return { width: WORLD_WIDTH, height: WORLD_HEIGHT, obstacles };
}
