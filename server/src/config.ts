import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { deriveGuestSecret } from './auth/guest.js';
import { DEFAULT_UNITS_PER_TYPE, MAX_UNITS_PER_TYPE, MIN_UNITS_PER_TYPE } from '@tkm/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
/** server/ */
export const SERVER_DIR = path.resolve(here, '..');
/** repo root */
export const ROOT_DIR = path.resolve(SERVER_DIR, '..');

/** Loads server/.env then repo-root .env (first value wins; real env vars win over both). */
export function loadDotenv(): void {
  dotenv.config({ path: path.join(SERVER_DIR, '.env') });
  dotenv.config({ path: path.join(ROOT_DIR, '.env') });
}

export interface AppConfig {
  mode: 'supabase' | 'dev';
  port: number;
  appUrl: string;
  isProduction: boolean;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabaseServiceRoleKey?: string;
  googleEnabled: boolean;
  devJwtSecret: string;
  /** HS256 secret for guest tokens (both modes). */
  guestJwtSecret: string;
  devDataFile: string;
  unitsPerType: number;
}

const DEV_SECRET_FALLBACK = 'tkm-savasi-dev-secret-change-me';

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const supabaseUrl = env.SUPABASE_URL?.trim() || undefined;
  const supabaseAnonKey = env.SUPABASE_ANON_KEY?.trim() || undefined;
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined;
  const mode = supabaseUrl && supabaseAnonKey && supabaseServiceRoleKey ? 'supabase' : 'dev';
  const devJwtSecret = env.DEV_JWT_SECRET?.trim() || DEV_SECRET_FALLBACK;

  const port = Number.parseInt(env.PORT ?? '', 10);
  let units = Number.parseInt(env.UNITS_PER_TYPE ?? '', 10);
  if (!Number.isFinite(units)) units = DEFAULT_UNITS_PER_TYPE;
  units = Math.min(MAX_UNITS_PER_TYPE, Math.max(MIN_UNITS_PER_TYPE, units));

  return {
    mode,
    port: Number.isFinite(port) && port > 0 ? port : 3001,
    appUrl: (env.APP_URL?.trim() || 'http://localhost:5173').replace(/\/+$/, ''),
    isProduction: env.NODE_ENV === 'production',
    supabaseUrl,
    supabaseAnonKey,
    supabaseServiceRoleKey,
    googleEnabled: mode === 'supabase' ? parseBool(env.GOOGLE_ENABLED, true) : false,
    devJwtSecret,
    guestJwtSecret: deriveGuestSecret({
      guestJwtSecret: env.GUEST_JWT_SECRET?.trim() || undefined,
      baseSecret: mode === 'supabase' ? supabaseServiceRoleKey! : devJwtSecret,
    }),
    devDataFile: path.join(SERVER_DIR, '.dev-data', 'db.json'),
    unitsPerType: units,
  };
}
