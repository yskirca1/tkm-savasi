import { UNIT_RADIUS, WORLD_HEIGHT, WORLD_WIDTH } from '@tkm/shared';
import type { Rect, Species } from '@tkm/shared';
import type { SimState, Unit } from './api.js';

export function mkState(units: Partial<Unit>[] & { species: Species }[], obstacles: Rect[] = []): SimState {
  return {
    seed: 0,
    map: { width: WORLD_WIDTH, height: WORLD_HEIGHT, obstacles },
    units: units.map((u) => ({ x: 0, y: 0, vx: 0, vy: 0, ...u }) as Unit),
    tick: 0,
    convertedSinceDrain: [],
  };
}

/** Penetration depth of unit into rect (0 if none). */
export function penetration(u: Unit, o: Rect): number {
  const px = Math.max(o.x, Math.min(u.x, o.x + o.w));
  const py = Math.max(o.y, Math.min(u.y, o.y + o.h));
  const inside = u.x > o.x && u.x < o.x + o.w && u.y > o.y && u.y < o.y + o.h;
  if (inside) return UNIT_RADIUS + 1;
  return Math.max(0, UNIT_RADIUS - Math.hypot(u.x - px, u.y - py));
}
