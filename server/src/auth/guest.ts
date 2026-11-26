// Guest sessions (no account), identical in dev and supabase mode: the server signs its own HS256 JWT.
// Verification is local and cheap, so it always runs before the mode's AuthProvider.
import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { GUEST_PREFIX, GUEST_SESSION_HOURS, type AuthSession } from '@tkm/shared';
import type { AuthProvider, VerifiedUser } from './types.js';

/** Guest user ids are `guest:<uuid>`. They never exist in the Store (no profile, no stats). */
export const GUEST_ID_PREFIX = 'guest:';
const ISSUER = 'tkm-guest';
const AUDIENCE = 'tkm-guest';
const SECRET_LABEL = 'tkm-guest-jwt-v1';

export function isGuestUserId(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && userId.startsWith(GUEST_ID_PREFIX);
}

/**
 * Guest signing secret: GUEST_JWT_SECRET if set, else HMAC-SHA256(base, fixed label) where base is the
 * Supabase service-role key (supabase mode) or the dev JWT secret (dev mode). No new env var required.
 */
export function deriveGuestSecret(opts: { guestJwtSecret?: string; baseSecret: string }): string {
  if (opts.guestJwtSecret) return opts.guestJwtSecret;
  return crypto.createHmac('sha256', opts.baseSecret).update(SECRET_LABEL).digest('hex');
}

export interface GuestIdentity extends VerifiedUser {
  userId: string;
  name: string;
  guest: true;
}

export class GuestAuth {
  private key: Uint8Array;

  constructor(
    secret: string,
    private random: () => number = () => crypto.randomInt(0, 10_000) / 10_000,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  /** New guest session: `Guest-1234`, expires after GUEST_SESSION_HOURS, no refresh token. */
  async issue(nowMs = Date.now()): Promise<AuthSession> {
    const iat = Math.floor(nowMs / 1000);
    const exp = iat + GUEST_SESSION_HOURS * 3600;
    const digits = Math.floor(this.random() * 10_000)
      .toString()
      .padStart(4, '0');
    const access_token = await new SignJWT({ guest: true, name: `${GUEST_PREFIX}-${digits}` })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(GUEST_ID_PREFIX + crypto.randomUUID())
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.key);
    return { access_token, refresh_token: '', expires_at: exp };
  }

  /** The guest identity, or null if this is not a valid (signed, unexpired) guest token. Never throws. */
  async verify(token: string): Promise<GuestIdentity | null> {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
      const sub = payload.sub;
      const name = payload.name;
      if (payload.guest !== true || !isGuestUserId(sub) || typeof name !== 'string' || !name) return null;
      return { userId: sub!, name, guest: true };
    } catch {
      return null;
    }
  }
}

/** Token → identity: guest verifier first (local), then the mode's AuthProvider. */
export function createTokenVerifier(guest: GuestAuth, auth: AuthProvider): (token: string) => Promise<VerifiedUser | null> {
  return async (token) => {
    if (!token) return null;
    const g = await guest.verify(token);
    if (g) return g;
    return auth.verifyToken(token);
  };
}
