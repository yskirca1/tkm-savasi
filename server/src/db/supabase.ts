import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProfileStats } from '@tkm/shared';
import { UsernameTakenError, type MatchRecord, type Profile, type Store } from './types.js';

interface ProfileRow {
  id: string;
  username: string;
  avatar_url: string | null;
}

/** Escape LIKE wildcards so ilike behaves as a case-insensitive equality. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function isUniqueViolation(err: { code?: string } | null): boolean {
  return !!err && err.code === '23505';
}

/** Store backed by Supabase Postgres via the service-role client (bypasses RLS). */
export class SupabaseStore implements Store {
  constructor(private admin: SupabaseClient) {}

  private toProfile(r: ProfileRow): Profile {
    return { id: r.id, username: r.username, avatarUrl: r.avatar_url };
  }

  async getProfile(id: string): Promise<Profile | null> {
    const { data, error } = await this.admin
      .from('profiles')
      .select('id, username, avatar_url')
      .eq('id', id)
      .maybeSingle<ProfileRow>();
    if (error) throw error;
    return data ? this.toProfile(data) : null;
  }

  async getProfileByUsername(name: string, ci = true): Promise<Profile | null> {
    const q = this.admin.from('profiles').select('id, username, avatar_url');
    const { data, error } = await (ci ? q.ilike('username', escapeLike(name)) : q.eq('username', name)).limit(1);
    if (error) throw error;
    const row = (data as ProfileRow[] | null)?.[0];
    return row ? this.toProfile(row) : null;
  }

  async isUsernameTaken(name: string, exceptId?: string): Promise<boolean> {
    const p = await this.getProfileByUsername(name, true);
    return !!p && p.id !== exceptId;
  }

  async createProfile(id: string, username: string, avatarUrl: string | null): Promise<Profile> {
    const { data, error } = await this.admin
      .from('profiles')
      .insert({ id, username, avatar_url: avatarUrl })
      .select('id, username, avatar_url')
      .single<ProfileRow>();
    if (isUniqueViolation(error)) throw new UsernameTakenError();
    if (error) throw error;
    return this.toProfile(data);
  }

  async renameProfile(id: string, username: string): Promise<Profile> {
    const { data, error } = await this.admin
      .from('profiles')
      .update({ username, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, username, avatar_url')
      .single<ProfileRow>();
    if (isUniqueViolation(error)) throw new UsernameTakenError();
    if (error) throw error;
    return this.toProfile(data);
  }

  async getStats(id: string): Promise<ProfileStats> {
    const { data, error } = await this.admin
      .from('profile_stats')
      .select('games_played, games_won, rounds_won')
      .eq('user_id', id)
      .maybeSingle<{ games_played: number; games_won: number; rounds_won: number }>();
    if (error) throw error;
    return {
      gamesPlayed: data?.games_played ?? 0,
      gamesWon: data?.games_won ?? 0,
      roundsWon: data?.rounds_won ?? 0,
    };
  }

  async saveMatch(m: MatchRecord): Promise<void> {
    const { data, error } = await this.admin
      .from('matches')
      .insert({
        room_code: m.roomCode,
        total_rounds: m.totalRounds,
        started_at: new Date(m.startedAt).toISOString(),
      })
      .select('id')
      .single<{ id: string }>();
    if (error) throw error;
    if (m.results.length === 0) return;
    const { error: e2 } = await this.admin.from('match_results').insert(
      m.results.map((r) => ({
        match_id: data.id,
        user_id: r.userId,
        rounds_won: r.roundsWon,
        is_winner: r.isWinner,
        finished_in_seat: r.finishedInSeat,
      })),
    );
    if (e2) {
      await this.admin.from('matches').delete().eq('id', data.id);
      throw e2;
    }
  }

  async getEmailForUser(id: string): Promise<string | null> {
    const { data, error } = await this.admin.auth.admin.getUserById(id);
    if (error || !data.user) return null;
    return data.user.email ?? null;
  }
}
