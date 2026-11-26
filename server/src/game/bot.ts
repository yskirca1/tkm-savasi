import { BOT_NAME, SPECIES, type Species } from '@tkm/shared';

export { BOT_NAME };

/** Species not yet taken this round. */
export function untakenSpecies(picks: readonly (Species | null)[]): Species[] {
  return SPECIES.filter((s) => !picks.includes(s));
}

/** Bot (and pick-timeout) choice: uniformly random among untaken species. */
export function randomUntaken(picks: readonly (Species | null)[], random: () => number): Species {
  const free = untakenSpecies(picks);
  if (free.length === 0) throw new Error('no species left');
  return free[Math.min(free.length - 1, Math.floor(random() * free.length))];
}

/** Bots always approve ending the round by vote while their species is alive. */
export const BOT_APPROVES_VOTE = true;
