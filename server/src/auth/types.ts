import type { AuthSession } from '@tkm/shared';

export interface VerifiedUser {
  userId: string;
  email?: string;
  /** Provider display name (Google full_name/name). */
  name?: string;
  avatarUrl?: string;
}

/**
 * Errors are thrown as HttpError (see ../errors.ts) with user-facing messages.
 * Login failures always use the same generic message.
 */
export interface AuthProvider {
  readonly mode: 'dev' | 'supabase';
  register(username: string, email: string, password: string): Promise<AuthSession>;
  login(identifier: string, password: string): Promise<AuthSession>;
  /** Never reveals whether the account exists. */
  forgot(identifier: string): Promise<void>;
  /** Dev mode only. */
  devReset(token: string, password: string): Promise<void>;
  /** Dev mode only. */
  devRefresh(refreshToken: string): Promise<AuthSession>;
  verifyToken(jwt: string): Promise<VerifiedUser | null>;
}
