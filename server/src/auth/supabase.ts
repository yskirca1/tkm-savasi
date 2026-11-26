import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthSession } from '@tkm/shared';
import { HttpError, MSG } from '../errors.js';
import type { Store } from '../db/types.js';
import { UsernameTakenError } from '../db/types.js';
import type { AuthProvider, VerifiedUser } from './types.js';
import { assertEmail, assertPassword, assertUsername } from './validation.js';

export interface SupabaseAuthOptions {
  url: string;
  anonKey: string;
  appUrl: string;
}

const VERIFY_CACHE_MS = 60_000;
const VERIFY_CACHE_MAX = 5_000;

export function createAdminClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export class SupabaseAuthProvider implements AuthProvider {
  readonly mode = 'supabase' as const;
  private cache = new Map<string, { user: VerifiedUser | null; at: number }>();

  constructor(
    private admin: SupabaseClient,
    private store: Store,
    private opts: SupabaseAuthOptions,
  ) {}

  /** Fresh anon client per request — never share session state between users. */
  private anon(flowType: 'implicit' | 'pkce' = 'implicit'): SupabaseClient {
    return createClient(this.opts.url, this.opts.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType },
    });
  }

  private async resolveEmail(identifier: string): Promise<string | null> {
    const id = identifier.trim();
    if (id.includes('@')) return id.toLowerCase();
    const profile = await this.store.getProfileByUsername(id, true);
    if (!profile) return null;
    return this.store.getEmailForUser(profile.id);
  }

  private async signIn(email: string, password: string): Promise<AuthSession> {
    const { data, error } = await this.anon().auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new HttpError(401, MSG.loginFailed);
    const s = data.session;
    return {
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_at: s.expires_at ?? Math.floor(Date.now() / 1000) + (s.expires_in ?? 3600),
    };
  }

  async register(username: string, email: string, password: string): Promise<AuthSession> {
    assertUsername(username);
    assertEmail(email);
    assertPassword(password);
    const emailLc = email.trim().toLowerCase();
    if (await this.store.isUsernameTaken(username)) throw new HttpError(409, MSG.usernameTaken);

    const { data, error } = await this.admin.auth.admin.createUser({
      email: emailLc,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 422 || status === 409 || /already/i.test(error?.message ?? '')) {
        throw new HttpError(409, MSG.emailUnavailable);
      }
      console.error('[auth] createUser failed:', error?.message);
      throw new HttpError(500, MSG.server);
    }
    const userId = data.user.id;
    try {
      await this.store.createProfile(userId, username, null);
    } catch (err) {
      await this.admin.auth.admin.deleteUser(userId).catch(() => {});
      if (err instanceof UsernameTakenError) throw new HttpError(409, MSG.usernameTaken);
      console.error('[auth] profile insert failed:', err);
      throw new HttpError(500, MSG.server);
    }
    return this.signIn(emailLc, password);
  }

  async login(identifier: string, password: string): Promise<AuthSession> {
    if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier.trim() || !password) {
      throw new HttpError(401, MSG.loginFailed);
    }
    const email = await this.resolveEmail(identifier).catch(() => null);
    if (!email) throw new HttpError(401, MSG.loginFailed);
    return this.signIn(email, password);
  }

  async forgot(identifier: string): Promise<void> {
    if (typeof identifier !== 'string' || !identifier.trim()) return;
    try {
      const email = await this.resolveEmail(identifier);
      if (!email) return;
      const { error } = await this.anon('implicit').auth.resetPasswordForEmail(email, {
        redirectTo: `${this.opts.appUrl}/reset`,
      });
      if (error) console.error('[auth] resetPasswordForEmail failed:', error.message);
    } catch (err) {
      console.error('[auth] forgot failed:', err);
    }
  }

  async devReset(): Promise<void> {
    throw new HttpError(404, MSG.notSupported);
  }

  async devRefresh(): Promise<AuthSession> {
    throw new HttpError(404, MSG.notSupported);
  }

  async verifyToken(jwt: string): Promise<VerifiedUser | null> {
    if (!jwt) return null;
    const now = Date.now();
    const hit = this.cache.get(jwt);
    if (hit && now - hit.at < VERIFY_CACHE_MS) return hit.user;

    let user: VerifiedUser | null = null;
    try {
      const { data, error } = await this.admin.auth.getUser(jwt);
      if (!error && data.user) {
        const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
        user = {
          userId: data.user.id,
          email: data.user.email ?? undefined,
          name: str(meta.full_name) ?? str(meta.name),
          avatarUrl: str(meta.avatar_url) ?? str(meta.picture),
        };
      }
    } catch (err) {
      console.error('[auth] verifyToken failed:', err);
      return null; // don't cache transient failures
    }
    if (this.cache.size >= VERIFY_CACHE_MAX) {
      for (const [k, v] of this.cache) if (now - v.at >= VERIFY_CACHE_MS) this.cache.delete(k);
      if (this.cache.size >= VERIFY_CACHE_MAX) this.cache.clear();
    }
    this.cache.set(jwt, { user, at: now });
    return user;
  }
}
