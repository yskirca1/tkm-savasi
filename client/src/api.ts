// REST client for /api (see shared/src/index.ts for shapes).
import type { AuthSession, MeResponse, PublicConfig } from '@tkm/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type TokenProvider = (forceRefresh?: boolean) => Promise<string | null>;
let tokenProvider: TokenProvider = async () => null;
let onUnauthorized: () => void = () => {};

export function setTokenProvider(p: TokenProvider, unauthorized: () => void): void {
  tokenProvider = p;
  onUnauthorized = unauthorized;
}

const GENERIC = 'Something went wrong. Please try again.';

async function raw<T>(method: string, path: string, body?: unknown, token?: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Can\'t reach the server. Check your internet connection.');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error;
    if (res.status === 429) throw new ApiError(429, msg || 'Too many attempts. Wait a bit and try again.');
    throw new ApiError(res.status, msg || GENERIC);
  }
  return data as T;
}

/** Authenticated request; retries once with a refreshed token on 401. */
async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await tokenProvider();
  if (!token) {
    onUnauthorized();
    throw new ApiError(401, 'Your session has expired. Please log in again.');
  }
  try {
    return await raw<T>(method, path, body, token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      const fresh = await tokenProvider(true);
      if (fresh && fresh !== token) return raw<T>(method, path, body, fresh);
      onUnauthorized();
    }
    throw e;
  }
}

export const api = {
  config: () => raw<PublicConfig>('GET', '/config'),
  usernameAvailable: (u: string) =>
    raw<{ available: boolean; reason?: string }>('GET', `/username-available?u=${encodeURIComponent(u)}`),
  register: (username: string, email: string, password: string) =>
    raw<AuthSession>('POST', '/auth/register', { username, email, password }),
  guest: () => raw<AuthSession>('POST', '/auth/guest', {}),
  login: (identifier: string, password: string) => raw<AuthSession>('POST', '/auth/login', { identifier, password }),
  forgot: (identifier: string) => raw<{ ok: true }>('POST', '/auth/forgot', { identifier }),
  devReset: (token: string, password: string) => raw<{ ok: true }>('POST', '/auth/reset', { token, password }),
  devRefresh: (refresh_token: string) => raw<AuthSession>('POST', '/auth/refresh', { refresh_token }),
  me: () => authed<MeResponse>('GET', '/me'),
  createProfile: (username: string) => authed<MeResponse>('POST', '/profile', { username }),
  renameProfile: (username: string) => authed<MeResponse>('PATCH', '/profile', { username }),
};
