import type { ProfileStats } from '@tkm/shared';

export interface Profile {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface MatchResultInput {
  userId: string;
  roundsWon: number;
  isWinner: boolean;
  finishedInSeat: boolean;
}

export interface MatchRecord {
  roomCode: string;
  totalRounds: number;
  /** epoch ms */
  startedAt: number;
  results: MatchResultInput[];
}

/** Thrown by createProfile / renameProfile when the (case-insensitive) username is taken. */
export class UsernameTakenError extends Error {
  constructor() {
    super('username_taken');
  }
}

export interface Store {
  getProfile(id: string): Promise<Profile | null>;
  /** ci=true → case-insensitive match. */
  getProfileByUsername(name: string, ci?: boolean): Promise<Profile | null>;
  /** Case-insensitive. exceptId lets a user keep / re-case their own name. */
  isUsernameTaken(name: string, exceptId?: string): Promise<boolean>;
  createProfile(id: string, username: string, avatarUrl: string | null): Promise<Profile>;
  renameProfile(id: string, username: string): Promise<Profile>;
  getStats(id: string): Promise<ProfileStats>;
  saveMatch(m: MatchRecord): Promise<void>;
  /** Server-only. Never send to clients. */
  getEmailForUser(id: string): Promise<string | null>;
}
