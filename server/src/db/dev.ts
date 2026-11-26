import crypto from 'node:crypto';
import type { ProfileStats } from '@tkm/shared';
import { DevDb, ciKey } from './devdb.js';
import { UsernameTakenError, type MatchRecord, type Profile, type Store } from './types.js';

export class DevStore implements Store {
  constructor(private db: DevDb) {}

  private toProfile(p: { id: string; username: string; avatarUrl: string | null }): Profile {
    return { id: p.id, username: p.username, avatarUrl: p.avatarUrl };
  }

  async getProfile(id: string): Promise<Profile | null> {
    const p = this.db.data.profiles.find((x) => x.id === id);
    return p ? this.toProfile(p) : null;
  }

  async getProfileByUsername(name: string, ci = true): Promise<Profile | null> {
    const p = ci
      ? this.db.data.profiles.find((x) => ciKey(x.username) === ciKey(name))
      : this.db.data.profiles.find((x) => x.username === name);
    return p ? this.toProfile(p) : null;
  }

  async isUsernameTaken(name: string, exceptId?: string): Promise<boolean> {
    const p = await this.getProfileByUsername(name, true);
    return !!p && p.id !== exceptId;
  }

  async createProfile(id: string, username: string, avatarUrl: string | null): Promise<Profile> {
    if (await this.isUsernameTaken(username, id)) throw new UsernameTakenError();
    if (this.db.data.profiles.some((p) => p.id === id)) throw new Error('profile exists');
    const now = Date.now();
    const p = { id, username, avatarUrl, createdAt: now, updatedAt: now };
    this.db.data.profiles.push(p);
    this.db.save();
    return this.toProfile(p);
  }

  async renameProfile(id: string, username: string): Promise<Profile> {
    if (await this.isUsernameTaken(username, id)) throw new UsernameTakenError();
    const p = this.db.data.profiles.find((x) => x.id === id);
    if (!p) throw new Error('profile not found');
    p.username = username;
    p.updatedAt = Date.now();
    this.db.save();
    return this.toProfile(p);
  }

  async getStats(id: string): Promise<ProfileStats> {
    const rows = this.db.data.results.filter((r) => r.userId === id);
    return {
      gamesPlayed: rows.length,
      gamesWon: rows.filter((r) => r.isWinner).length,
      roundsWon: rows.reduce((s, r) => s + r.roundsWon, 0),
    };
  }

  async saveMatch(m: MatchRecord): Promise<void> {
    const id = crypto.randomUUID();
    this.db.data.matches.push({
      id,
      roomCode: m.roomCode,
      totalRounds: m.totalRounds,
      startedAt: m.startedAt,
      endedAt: Date.now(),
    });
    for (const r of m.results) {
      this.db.data.results.push({ matchId: id, ...r });
    }
    this.db.save();
  }

  async getEmailForUser(id: string): Promise<string | null> {
    return this.db.data.users.find((u) => u.id === id)?.email ?? null;
  }
}
