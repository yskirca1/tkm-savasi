import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { GUEST_SESSION_HOURS, type AuthSession, type MeResponse } from '@tkm/shared';
import { loadConfig } from '../config.js';
import { DevDb } from '../db/devdb.js';
import { DevStore } from '../db/dev.js';
import { HttpError, MSG } from '../errors.js';
import { DevAuthProvider } from './dev.js';
import { GuestAuth, createTokenVerifier, deriveGuestSecret, isGuestUserId } from './guest.js';
import { createApiRouter } from './routes.js';
import { suggestUsername, usernameBaseFromName, usernameError } from './validation.js';

const GUEST_SECRET = 'guest-test-secret';

function make() {
  const db = new DevDb(null);
  const store = new DevStore(db);
  const auth = new DevAuthProvider(db, store, { secret: 'dev-test-secret', appUrl: 'http://app.test', logResetLink: () => {} });
  const guest = new GuestAuth(GUEST_SECRET);
  return { db, store, auth, guest, verify: createTokenVerifier(guest, auth) };
}

describe('guest tokens', () => {
  it('round-trips: Guest-NNNN name, guest: id, 24 h expiry, no refresh token', async () => {
    const { guest } = make();
    const now = Date.now();
    const s = await guest.issue(now);
    expect(s.refresh_token).toBe('');
    expect(s.expires_at).toBe(Math.floor(now / 1000) + GUEST_SESSION_HOURS * 3600);
    const id = await guest.verify(s.access_token);
    expect(id).not.toBeNull();
    expect(id!.guest).toBe(true);
    expect(id!.userId).toMatch(/^guest:[0-9a-f-]{36}$/);
    expect(id!.name).toMatch(/^Guest-\d{4}$/);
    expect(isGuestUserId(id!.userId)).toBe(true);
    // each session is a distinct identity
    const other = await guest.verify((await guest.issue()).access_token);
    expect(other!.userId).not.toBe(id!.userId);
  });

  it('rejects tampered, foreign-secret and expired tokens', async () => {
    const { guest } = make();
    const s = await guest.issue();
    const [h, p, sig] = s.access_token.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, name: 'Admin' })).toString('base64url');
    expect(await guest.verify(`${h}.${forged}.${sig}`)).toBeNull();
    expect(await guest.verify(s.access_token.slice(0, -3) + 'abc')).toBeNull();
    expect(await new GuestAuth('another-secret').verify(s.access_token)).toBeNull();
    const expired = await guest.issue(Date.now() - (GUEST_SESSION_HOURS * 3600 + 60) * 1000);
    expect(await guest.verify(expired.access_token)).toBeNull();
    expect(await guest.verify('')).toBeNull();
    expect(await guest.verify('not.a.jwt')).toBeNull();
  });

  it('a token without the guest claim is not a guest even if signed with the guest secret', async () => {
    const { guest } = make();
    const key = new TextEncoder().encode(GUEST_SECRET);
    const t = await new SignJWT({ name: 'Guest-1234' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('guest:abc')
      .setIssuer('tkm-guest')
      .setAudience('tkm-guest')
      .setExpirationTime('1h')
      .sign(key);
    expect(await guest.verify(t)).toBeNull();
  });

  it('registered tokens are not guests and guest tokens are not registered users', async () => {
    const { guest, auth, verify } = make();
    const reg = await auth.register('Ayse', 'ayse@example.com', 'password123');
    expect(await guest.verify(reg.access_token)).toBeNull();
    const regUser = await verify(reg.access_token);
    expect(regUser?.guest).toBeFalsy();
    expect(regUser?.userId).toBeTruthy();

    const g = await guest.issue();
    expect(await auth.verifyToken(g.access_token)).toBeNull();
    expect((await verify(g.access_token))?.guest).toBe(true);
  });

  it('derives a guest secret from the base secret unless GUEST_JWT_SECRET is set', () => {
    const a = deriveGuestSecret({ baseSecret: 'base' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe('base');
    expect(deriveGuestSecret({ baseSecret: 'base' })).toBe(a);
    expect(deriveGuestSecret({ baseSecret: 'other' })).not.toBe(a);
    expect(deriveGuestSecret({ baseSecret: 'base', guestJwtSecret: 'explicit' })).toBe('explicit');
    const cfg = loadConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'srk' });
    expect(cfg.guestJwtSecret).toBe(deriveGuestSecret({ baseSecret: 'srk' }));
  });
});

describe('reserved "guest" usernames', () => {
  it('usernameError rejects names starting with guest in any case', () => {
    for (const u of ['guest', 'Guest1', 'GUEST_x', 'gUeSt.abc']) expect(usernameError(u)).toBe(MSG.usernameGuest);
    expect(usernameError('myguest')).toBeNull();
    expect(usernameError('Ayse')).toBeNull();
  });

  it('register rejects guest* usernames', async () => {
    const { auth } = make();
    for (const u of ['guest42', 'GUEST42']) {
      const e = await auth.register(u, `${u}@example.com`, 'password123').catch((x) => x);
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).message).toBe(MSG.usernameGuest);
    }
  });

  it('the Google username suggestion never produces a guest name', async () => {
    expect(usernameBaseFromName('Guest User')).toBe('playeruser');
    expect(usernameBaseFromName('GUEST')).toBe('player');
    expect(await suggestUsername('Guest', async () => false)).not.toMatch(/^guest/i);
  });
});

describe('REST: guest endpoints', () => {
  const env = make();
  let base = '';
  let server: http.Server;

  beforeAll(async () => {
    const app = express();
    app.use('/api', createApiRouter({ config: loadConfig({}), auth: env.auth, guest: env.guest, store: env.store }));
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('POST /auth/guest + /me returns the guest shape', async () => {
    const s = (await call('POST', '/auth/guest')).body as unknown as AuthSession;
    expect(s.refresh_token).toBe('');
    const me = (await call('GET', '/me', s.access_token)) as { status: number; body: unknown };
    expect(me.status).toBe(200);
    const m = me.body as MeResponse;
    expect(m.guest).toBe(true);
    expect(m.userId).toMatch(/^guest:/);
    expect(m.profile?.username).toMatch(/^Guest-\d{4}$/);
    expect(m.profile?.avatarUrl).toBeNull();
    expect(m.stats).toEqual({ gamesPlayed: 0, gamesWon: 0, roundsWon: 0 });
    expect(m.suggestedUsername).toBeUndefined();
    expect(env.db.data.users).toHaveLength(0);
  });

  it('guests get 403 on POST/PATCH /profile', async () => {
    const s = (await call('POST', '/auth/guest')).body as unknown as AuthSession;
    for (const method of ['POST', 'PATCH']) {
      const r = await call(method, '/profile', s.access_token, { username: 'NewName' });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe(MSG.guestNoRename);
    }
  });

  it('registered users get guest: false; rename to guest* is rejected; availability reports the reason', async () => {
    const s = await env.auth.register('Burak', 'burak@example.com', 'password123');
    const me = (await call('GET', '/me', s.access_token)).body as unknown as MeResponse;
    expect(me.guest).toBe(false);
    const r = await call('PATCH', '/profile', s.access_token, { username: 'GuestStar' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(MSG.usernameGuest);
    const avail = await call('GET', '/username-available?u=guest_1');
    expect(avail.body).toEqual({ available: false, reason: MSG.usernameGuest });
  });

  it('rejects a tampered guest token with 401', async () => {
    const s = (await call('POST', '/auth/guest')).body as unknown as AuthSession;
    expect((await call('GET', '/me', s.access_token.slice(0, -2) + 'xx')).status).toBe(401);
  });
});
