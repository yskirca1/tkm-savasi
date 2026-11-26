// In-memory data for dev mode, persisted to server/.dev-data/db.json.
// Shared by the dev AuthProvider (users/tokens) and the dev Store (profiles/matches).
import fs from 'node:fs';
import path from 'node:path';

export interface DevUser {
  id: string;
  email: string; // stored lowercased
  passwordHash: string; // hex
  salt: string; // hex
  createdAt: number;
}
export interface DevProfile {
  id: string;
  username: string;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface DevMatch {
  id: string;
  roomCode: string;
  totalRounds: number;
  startedAt: number;
  endedAt: number;
}
export interface DevMatchResult {
  matchId: string;
  userId: string;
  roundsWon: number;
  isWinner: boolean;
  finishedInSeat: boolean;
}
/** Tokens are stored by sha256 hash, never in clear. */
export interface DevToken {
  userId: string;
  expiresAt: number; // epoch ms
}

export interface DevData {
  users: DevUser[];
  profiles: DevProfile[];
  matches: DevMatch[];
  results: DevMatchResult[];
  refreshTokens: Record<string, DevToken>;
  resetTokens: Record<string, DevToken>;
}

function empty(): DevData {
  return { users: [], profiles: [], matches: [], results: [], refreshTokens: {}, resetTokens: {} };
}

export class DevDb {
  data: DevData;
  private saveTimer: NodeJS.Timeout | null = null;

  /** file=null → memory only (tests). */
  constructor(private file: string | null) {
    this.data = empty();
    if (file && fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DevData>;
        this.data = { ...empty(), ...parsed };
      } catch (err) {
        console.error(`[dev-db] could not read ${file}, starting empty:`, err);
      }
    }
  }

  /** Debounced atomic write. */
  save(): void {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 50);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[dev-db] write failed:', err);
    }
  }
}

export function ciKey(name: string): string {
  return name.toLowerCase();
}
