import { describe, expect, it } from 'vitest';
import { DevDb } from '../db/devdb.js';
import { DevStore } from '../db/dev.js';
import { HttpError, MSG } from '../errors.js';
import { DevAuthProvider } from './dev.js';
import { suggestUsername, usernameBaseFromName } from './validation.js';

function make() {
  const db = new DevDb(null);
  const store = new DevStore(db);
  const links: string[] = [];
  const auth = new DevAuthProvider(db, store, { secret: 'test-secret', appUrl: 'http://app.test', logResetLink: (l) => links.push(l) });
  return { db, store, auth, links };
}

async function err(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    return e as HttpError;
  }
  throw new Error('expected rejection');
}

describe('dev auth', () => {
  it('registers and returns a verifiable session; profile created; password hashed', async () => {
    const { auth, store, db } = make();
    const s = await auth.register('Ayşe_1', 'ayse@example.com', 'sifre1234');
    expect(s.access_token.split('.')).toHaveLength(3);
    expect(s.refresh_token.length).toBeGreaterThan(20);
    expect(s.expires_at).toBeGreaterThan(Date.now() / 1000 + 3500);
    const v = await auth.verifyToken(s.access_token);
    expect(v?.userId).toBeTruthy();
    expect((await store.getProfile(v!.userId))?.username).toBe('Ayşe_1');
    expect(JSON.stringify(db.data)).not.toContain('sifre1234');
    expect(db.data.users[0].salt).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects duplicate usernames case-insensitively', async () => {
    const { auth } = make();
    await auth.register('Player', 'a@example.com', 'sifre1234');
    const e = await err(auth.register('player', 'b@example.com', 'sifre1234'));
    expect(e.status).toBe(409);
    expect(e.message).toBe(MSG.usernameTaken);
  });

  it('validates input', async () => {
    const { auth } = make();
    expect((await err(auth.register('ab', 'a@example.com', 'sifre1234'))).status).toBe(400);
    expect((await err(auth.register('abc', 'not-an-email', 'sifre1234'))).message).toBe(MSG.emailInvalid);
    expect((await err(auth.register('abc', 'a@example.com', 'short'))).message).toBe(MSG.passwordShort);
  });

  it('logs in by username (any case) and by email', async () => {
    const { auth } = make();
    const s = await auth.register('Kerem', 'Kerem@Example.com', 'sifre1234');
    const uid = (await auth.verifyToken(s.access_token))!.userId;
    const byName = await auth.login('kerem', 'sifre1234');
    expect((await auth.verifyToken(byName.access_token))!.userId).toBe(uid);
    const byEmail = await auth.login('kerem@example.com', 'sifre1234');
    expect((await auth.verifyToken(byEmail.access_token))!.userId).toBe(uid);
  });

  it('wrong password and unknown user give the same generic error', async () => {
    const { auth } = make();
    await auth.register('Kerem', 'kerem@example.com', 'sifre1234');
    const e1 = await err(auth.login('Kerem', 'yanlis-sifre'));
    const e2 = await err(auth.login('yokboyle', 'sifre1234'));
    const e3 = await err(auth.login('yok@example.com', 'sifre1234'));
    for (const e of [e1, e2, e3]) {
      expect(e.status).toBe(401);
      expect(e.message).toBe(MSG.loginFailed);
    }
  });

  it('refresh tokens rotate and are single-use', async () => {
    const { auth } = make();
    const s = await auth.register('Kerem', 'kerem@example.com', 'sifre1234');
    const s2 = await auth.devRefresh(s.refresh_token);
    expect(await auth.verifyToken(s2.access_token)).not.toBeNull();
    expect((await err(auth.devRefresh(s.refresh_token))).status).toBe(401);
  });

  it('forgot logs a single-use reset link; reset changes the password', async () => {
    const { auth, links } = make();
    await auth.register('Kerem', 'kerem@example.com', 'sifre1234');
    await auth.forgot('nobody'); // silently ignored
    expect(links).toHaveLength(0);
    await auth.forgot('kerem');
    expect(links).toHaveLength(1);
    const token = links[0].split('#dev_token=')[1];
    expect(links[0].startsWith('http://app.test/reset#dev_token=')).toBe(true);
    await auth.devReset(token, 'yenisifre99');
    expect((await err(auth.devReset(token, 'baskasifre1'))).message).toBe(MSG.resetInvalid);
    await err(auth.login('kerem', 'sifre1234'));
    expect(await auth.login('kerem', 'yenisifre99')).toBeTruthy();
  });

  it('rejects tampered tokens', async () => {
    const { auth } = make();
    const s = await auth.register('Kerem', 'kerem@example.com', 'sifre1234');
    expect(await auth.verifyToken(s.access_token.slice(0, -2) + 'xx')).toBeNull();
    expect(await auth.verifyToken('garbage')).toBeNull();
  });
});

describe('username suggestion', () => {
  it('transliterates Turkish, strips invalid chars, trims and pads', () => {
    expect(usernameBaseFromName('Şükrü Çağlar Öztürk')).toBe('sukrucaglarozturk'.slice(0, 16));
    expect(usernameBaseFromName('İLKER Işık')).toBe('ilkerisik');
    expect(usernameBaseFromName('Al')).toBe('alplayer');
    expect(usernameBaseFromName('')).toBe('player');
    expect(usernameBaseFromName('!!!')).toBe('player');
  });

  it('appends 2-4 random digits until free', async () => {
    const taken = new Set(['ali']);
    const u = await suggestUsername('Ali', async (x) => taken.has(x.toLowerCase()));
    expect(u).toMatch(/^ali\d{2,4}$/);
    expect(await suggestUsername('Veli', async () => false)).toBe('veli');
  });
});
