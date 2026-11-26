// Dev-mode auth: users in DevDb (persisted JSON), scrypt password hashes,
// HS256 access JWTs (1h) and opaque single-use refresh tokens stored server-side.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import type { AuthSession } from '@tkm/shared';
import { HttpError, MSG } from '../errors.js';
import type { DevDb } from '../db/devdb.js';
import type { Store } from '../db/types.js';
import { UsernameTakenError } from '../db/types.js';
import type { AuthProvider, VerifiedUser } from './types.js';
import { assertEmail, assertPassword, assertUsername } from './validation.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const ACCESS_TTL_SEC = 60 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const ISSUER = 'tkm-dev';

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function hashPassword(pw: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return { hash: key.toString('hex'), salt: salt.toString('hex') };
}

export interface DevAuthOptions {
  secret: string;
  appUrl: string;
  /** Where the reset link goes (console by default). */
  logResetLink?: (link: string) => void;
}

export class DevAuthProvider implements AuthProvider {
  readonly mode = 'dev' as const;
  private key: Uint8Array;

  constructor(
    private db: DevDb,
    private store: Store,
    private opts: DevAuthOptions,
  ) {
    this.key = new TextEncoder().encode(opts.secret);
  }

  private async issueSession(userId: string): Promise<AuthSession> {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + ACCESS_TTL_SEC;
    const access_token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.key);
    const refresh_token = crypto.randomBytes(32).toString('base64url');
    this.pruneTokens();
    this.db.data.refreshTokens[sha256(refresh_token)] = { userId, expiresAt: Date.now() + REFRESH_TTL_MS };
    this.db.save();
    return { access_token, refresh_token, expires_at: exp };
  }

  private pruneTokens(): void {
    const now = Date.now();
    for (const bag of [this.db.data.refreshTokens, this.db.data.resetTokens]) {
      for (const [k, v] of Object.entries(bag)) if (v.expiresAt <= now) delete bag[k];
    }
  }

  private findUserByIdentifier(identifier: string) {
    const id = identifier.trim();
    if (id.includes('@')) {
      const email = id.toLowerCase();
      return Promise.resolve(this.db.data.users.find((u) => u.email === email) ?? null);
    }
    return this.store.getProfileByUsername(id, true).then((p) => (p ? this.db.data.users.find((u) => u.id === p.id) ?? null : null));
  }

  async register(username: string, email: string, password: string): Promise<AuthSession> {
    assertUsername(username);
    assertEmail(email);
    assertPassword(password);
    const emailLc = email.trim().toLowerCase();
    if (await this.store.isUsernameTaken(username)) throw new HttpError(409, MSG.usernameTaken);
    if (this.db.data.users.some((u) => u.email === emailLc)) throw new HttpError(409, MSG.emailUnavailable);
    const id = crypto.randomUUID();
    const { hash, salt } = await hashPassword(password);
    // re-check after the await (another request may have raced us)
    if (this.db.data.users.some((u) => u.email === emailLc)) throw new HttpError(409, MSG.emailUnavailable);
    this.db.data.users.push({ id, email: emailLc, passwordHash: hash, salt, createdAt: Date.now() });
    try {
      await this.store.createProfile(id, username, null);
    } catch (err) {
      this.db.data.users = this.db.data.users.filter((u) => u.id !== id);
      if (err instanceof UsernameTakenError) throw new HttpError(409, MSG.usernameTaken);
      throw err;
    }
    this.db.save();
    return this.issueSession(id);
  }

  async login(identifier: string, password: string): Promise<AuthSession> {
    if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier.trim()) {
      throw new HttpError(401, MSG.loginFailed);
    }
    const user = await this.findUserByIdentifier(identifier);
    // Always run scrypt to keep timing similar for unknown users.
    const { hash } = await hashPassword(password, user?.salt ?? '00'.repeat(16));
    if (!user) throw new HttpError(401, MSG.loginFailed);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(user.passwordHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, MSG.loginFailed);
    return this.issueSession(user.id);
  }

  async forgot(identifier: string): Promise<void> {
    if (typeof identifier !== 'string' || !identifier.trim()) return;
    const user = await this.findUserByIdentifier(identifier);
    if (!user) return;
    const token = crypto.randomBytes(32).toString('base64url');
    this.pruneTokens();
    this.db.data.resetTokens[sha256(token)] = { userId: user.id, expiresAt: Date.now() + RESET_TTL_MS };
    this.db.save();
    const link = `${this.opts.appUrl}/reset#dev_token=${token}`;
    (this.opts.logResetLink ?? ((l) => console.log(`[dev-auth] password reset link: ${l}`)))(link);
  }

  async devReset(token: string, password: string): Promise<void> {
    if (typeof token !== 'string' || !token) throw new HttpError(400, MSG.resetInvalid);
    assertPassword(password);
    const key = sha256(token);
    const entry = this.db.data.resetTokens[key];
    if (!entry || entry.expiresAt <= Date.now()) throw new HttpError(400, MSG.resetInvalid);
    const user = this.db.data.users.find((u) => u.id === entry.userId);
    if (!user) throw new HttpError(400, MSG.resetInvalid);
    delete this.db.data.resetTokens[key]; // single use
    const { hash, salt } = await hashPassword(password);
    user.passwordHash = hash;
    user.salt = salt;
    // invalidate existing refresh tokens for this user
    for (const [k, v] of Object.entries(this.db.data.refreshTokens)) if (v.userId === user.id) delete this.db.data.refreshTokens[k];
    this.db.save();
  }

  async devRefresh(refreshToken: string): Promise<AuthSession> {
    if (typeof refreshToken !== 'string' || !refreshToken) throw new HttpError(401, MSG.refreshInvalid);
    const key = sha256(refreshToken);
    const entry = this.db.data.refreshTokens[key];
    if (!entry) throw new HttpError(401, MSG.refreshInvalid);
    delete this.db.data.refreshTokens[key]; // rotate
    if (entry.expiresAt <= Date.now() || !this.db.data.users.some((u) => u.id === entry.userId)) {
      this.db.save();
      throw new HttpError(401, MSG.refreshInvalid);
    }
    return this.issueSession(entry.userId);
  }

  async verifyToken(jwt: string): Promise<VerifiedUser | null> {
    if (!jwt) return null;
    try {
      const { payload } = await jwtVerify(jwt, this.key, { issuer: ISSUER, algorithms: ['HS256'] });
      const user = payload.sub ? this.db.data.users.find((u) => u.id === payload.sub) : undefined;
      if (!user) return null;
      return { userId: user.id, email: user.email };
    } catch {
      return null;
    }
  }
}
