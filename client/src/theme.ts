import type { Species } from '@tkm/shared';
import { SPECIES } from '@tkm/shared';

/** Species identity colors (dark theme: deep = light text/ring tone, tint = dark surface). Keep in sync with styles.css tokens. */
export const SPECIES_COLOR: Record<Species, { main: string; deep: string; tint: string }> = {
  rock: { main: '#F59E0B', deep: '#FCD34D', tint: '#3A2A12' },
  paper: { main: '#38BDF8', deep: '#7DD3FC', tint: '#0F2C44' },
  scissors: { main: '#F43F5E', deep: '#FDA4AF', tint: '#3F1426' },
};

export const SPECIES_BY_INDEX: readonly Species[] = SPECIES;
