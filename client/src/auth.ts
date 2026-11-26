// Auth module: abstracts supabase mode (supabase-js) and dev mode (localStorage + /api/auth/refresh).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthSession, MeResponse, PublicConfig } from '@tkm/shared';
import { api, setTokenProvider } from './api';
import { Emitter } from './dom';

const DEV_KEY = 'tkm.devSession';
const NEXT_KEY = 'tkm.next';

let config: PublicConfig | null = null;
let supabase: SupabaseClient | null = null;
let devSession: AuthSession | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<AuthSession | null> | null = null;
let me: MeResponse | null = null;

/** Hash captured at startup (before supabase-js consumes it). */
const initialHash = location.hash;
export const startupHash = new URLSearchParams(initialHash.replace(/^#/, ''));

export const authEvents = new Emitter<{ change: boolean; recovery: void; unauthorized: void }>();

export function getConfig(): PublicConfig {
  if (!config) throw new Error('config not loaded');
  return config;
}

export async function initAuth(cfg: PublicConfig): Promise<void> {
  config = cfg;
  setTokenProvider(getToken, () => authEvents.emit('unauthorized', undefined));
  if (cfg.mode === 'supabase' && cfg.supabaseUrl && cfg.supabaseAnonKey) {
    const { createClient } = await import('@supabase/supabase-js');
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });
    supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') authEvents.emit('recovery', undefined);
      if (event === 'SIGNED_OUT') {
        me = null;
        authEvents.emit('change', false);
      }
    });
    // Waits for URL session detection (OAuth / recovery links) to finish.
    await supabase.auth.getSession();
  } else {
    try {
      const s = localStorage.getItem(DEV_KEY);
      devSession = s ? (JSON.parse(s) as AuthSession) : null;
    } catch {
      devSession = null;
    }
    if (devSession) {
      if (devSession.expires_at - nowSec() < 30) await devRefresh();
      else scheduleDevRefresh();
    }
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

function storeDev(s: AuthSession | null): void {
  devSession = s;
  try {
    if (s) localStorage.setItem(DEV_KEY, JSON.stringify(s));
    else localStorage.removeItem(DEV_KEY);
  } catch {
    /* ignore */
  }
  scheduleDevRefresh();
}

function scheduleDevRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!devSession) return;
  const ms = Math.max(5_000, (devSession.expires_at - nowSec() - 60) * 1000);
  refreshTimer = setTimeout(() => void devRefresh(), Math.min(ms, 2 ** 31 - 1));
}

async function devRefresh(): Promise<AuthSession | null> {
  if (!devSession) return null;
  if (refreshing) return refreshing;
  const rt = devSession.refresh_token;
  refreshing = api
    .devRefresh(rt)
    .then((s) => {
      storeDev(s);
      return s;
    })
    .catch((e: { status?: number }) => {
      // Network error: keep the session, retry later. Auth error: drop it.
      if (e.status && e.status >= 400 && e.status < 500) {
        storeDev(null);
        me = null;
        authEvents.emit('change', false);
      } else {
        refreshTimer = setTimeout(() => void devRefresh(), 10_000);
      }
      return devSession;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** A fresh access token, or null if logged out. */
export async function getToken(forceRefresh = false): Promise<string | null> {
  if (supabase) {
    if (forceRefresh) {
      const { data } = await supabase.auth.refreshSession();
      return data.session?.access_token ?? null;
    }
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }
  if (!devSession) return null;
  if (forceRefresh || devSession.expires_at - nowSec() < 30) await devRefresh();
  return devSession?.access_token ?? null;
}

export async function isLoggedIn(): Promise<boolean> {
  return (await getToken()) !== null;
}

async function adoptSession(s: AuthSession): Promise<void> {
  if (supabase) {
    const { error } = await supabase.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
    if (error) throw error;
  } else {
    storeDev(s);
  }
  me = null;
  authEvents.emit('change', true);
}

export async function loginWithPassword(identifier: string, password: string): Promise<void> {
  await adoptSession(await api.login(identifier, password));
}

export async function register(username: string, email: string, password: string): Promise<void> {
  await adoptSession(await api.register(username, email, password));
}

export async function loginWithGoogle(): Promise<void> {
  if (!supabase) throw new Error('Google login is unavailable right now.');
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin },
  });
  if (error) throw error;
}

export async function logout(): Promise<void> {
  me = null;
  if (supabase) await supabase.auth.signOut({ scope: 'local' });
  else storeDev(null);
  authEvents.emit('change', false);
}

/** supabase mode: set new password using the recovery session. */
export async function updatePasswordWithRecovery(password: string): Promise<void> {
  if (!supabase) throw new Error('unsupported');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw new Error(error.message.includes('different') ? 'The new password must be different from the old one.' : 'Couldn\'t update your password. The link may have expired.');
}

export function hasRecoverySession(): Promise<boolean> {
  return isLoggedIn();
}

// ---------- current user profile ----------
export async function loadMe(force = false): Promise<MeResponse> {
  if (me && !force) return me;
  me = await api.me();
  return me;
}
export function currentMe(): MeResponse | null {
  return me;
}
export function setMe(m: MeResponse): void {
  me = m;
}

// ---------- return-to path (e.g. invite links opened while logged out) ----------
export function setNext(path: string): void {
  try {
    sessionStorage.setItem(NEXT_KEY, path);
  } catch {
    /* ignore */
  }
}
export function consumeNext(): string | null {
  try {
    const v = sessionStorage.getItem(NEXT_KEY);
    sessionStorage.removeItem(NEXT_KEY);
    return v && v.startsWith('/') && !v.startsWith('//') ? v : null;
  } catch {
    return null;
  }
}
