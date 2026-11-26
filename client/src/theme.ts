import type { Species } from '@tkm/shared';
import { SPECIES } from '@tkm/shared';

/** Species identity colors — used in picks, scoreboard and canvas. Keep in sync with styles.css tokens. */
export const SPECIES_COLOR: Record<Species, { main: string; deep: string; tint: string }> = {
  rock: { main: '#F59E0B', deep: '#B45309', tint: '#FEF3C7' },
  paper: { main: '#38BDF8', deep: '#0369A1', tint: '#E0F2FE' },
  scissors: { main: '#F43F5E', deep: '#BE123C', tint: '#FFE4E6' },
};

export const SPECIES_BY_INDEX: readonly Species[] = SPECIES;
