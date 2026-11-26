import crypto from 'node:crypto';
import { PASSWORD_MIN, USERNAME_RE } from '@tkm/shared';
import { HttpError, MSG } from '../errors.js';

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function usernameError(u: unknown): string | null {
  if (typeof u !== 'string' || !USERNAME_RE.test(u)) return MSG.usernameInvalid;
  if (isReservedGuestName(u)) return MSG.usernameGuest;
  return null;
}

/** Names starting with "guest" (any case) are reserved for guest sessions. */
export function isReservedGuestName(u: string): boolean {
  return /^guest/i.test(u);
}

export function assertUsername(u: unknown): asserts u is string {
  const e = usernameError(u);
  if (e) throw new HttpError(400, e);
}

export function assertEmail(e: unknown): asserts e is string {
  if (typeof e !== 'string' || e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, MSG.emailInvalid);
}

export function assertPassword(p: unknown): asserts p is string {
  if (typeof p !== 'string' || p.length < PASSWORD_MIN) throw new HttpError(400, MSG.passwordShort);
  if (p.length > 200) throw new HttpError(400, MSG.badRequest);
}

const TR_MAP: Record<string, string> = {
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', I: 'i', İ: 'i', ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u',
};

/** Base username from a provider display name (no uniqueness check). */
export function usernameBaseFromName(name: string | undefined | null): string {
  let s = (name ?? '').replace(/[çÇğĞıIİöÖşŞüÜ]/g, (c) => TR_MAP[c] ?? c);
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/[^a-z0-9_.]/g, '');
  // Never suggest a reserved guest name (lowercased already): "guest_x" -> "player_x".
  if (isReservedGuestName(s)) s = 'player' + s.slice(5);
  s = s.slice(0, 16);
  if (s.length < 3) s = (s + 'player').slice(0, 16);
  return s;
}

/** Suggest a free username: base, else base + 2–4 random digits until free. */
export async function suggestUsername(
  name: string | undefined | null,
  isTaken: (u: string) => Promise<boolean>,
  random: () => number = () => crypto.randomInt(0, 1_000_000) / 1_000_000,
): Promise<string> {
  const base = usernameBaseFromName(name);
  if (!(await isTaken(base))) return base;
  for (let attempt = 0; attempt < 60; attempt++) {
    const digits = 2 + Math.min(2, Math.floor(attempt / 20)); // 2, then 3, then 4 digits
    const n = Math.floor(random() * 10 ** digits)
      .toString()
      .padStart(digits, '0');
    const cand = base + n;
    if (!(await isTaken(cand))) return cand;
  }
  return base.slice(0, 12) + crypto.randomInt(10_000_000, 99_999_999).toString();
}
