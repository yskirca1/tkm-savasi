import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { MeResponse, PublicConfig } from '@tkm/shared';
import type { AppConfig } from '../config.js';
import { HttpError, MSG } from '../errors.js';
import type { Store } from '../db/types.js';
import { UsernameTakenError } from '../db/types.js';
import type { AuthProvider, VerifiedUser } from './types.js';
import { assertUsername, suggestUsername, usernameError } from './validation.js';

export interface ApiDeps {
  config: AppConfig;
  auth: AuthProvider;
  store: Store;
  /** Propagate a rename into live rooms. */
  onRename?: (userId: string, username: string) => void;
}

type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;
const wrap =
  (fn: AsyncHandler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

function limiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: MSG.rateLimited },
  });
}

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function createApiRouter(deps: ApiDeps): Router {
  const { config, auth, store } = deps;
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }));

  const requireUser = async (req: Request): Promise<VerifiedUser> => {
    const token = bearer(req);
    const user = token ? await auth.verifyToken(token) : null;
    if (!user) throw new HttpError(401, MSG.unauthorized);
    return user;
  };

  const me = async (user: VerifiedUser): Promise<MeResponse> => {
    const [profile, stats] = await Promise.all([store.getProfile(user.userId), store.getStats(user.userId)]);
    const out: MeResponse = {
      userId: user.userId,
      profile: profile ? { username: profile.username, avatarUrl: profile.avatarUrl } : null,
      stats,
    };
    if (!profile) {
      out.suggestedUsername = await suggestUsername(user.name ?? null, (u) => store.isUsernameTaken(u));
    }
    return out;
  };

  r.get('/config', (_req, res) => {
    const body: PublicConfig =
      config.mode === 'supabase'
        ? { mode: 'supabase', supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.supabaseAnonKey, googleEnabled: config.googleEnabled }
        : { mode: 'dev', googleEnabled: false };
    res.json(body);
  });

  r.get(
    '/username-available',
    limiter(60_000, 60),
    wrap(async (req, res) => {
      const u = str(req.query.u);
      const err = usernameError(u);
      if (err) return res.json({ available: false, reason: err });
      const token = bearer(req);
      const user = token ? await auth.verifyToken(token) : null;
      const taken = await store.isUsernameTaken(u, user?.userId);
      res.json(taken ? { available: false, reason: MSG.usernameTaken } : { available: true });
    }),
  );

  const authLimit = () => limiter(15 * 60_000, 10);

  r.post(
    '/auth/register',
    authLimit(),
    wrap(async (req, res) => {
      const b = req.body ?? {};
      res.json(await auth.register(str(b.username).trim(), str(b.email).trim(), str(b.password)));
    }),
  );

  r.post(
    '/auth/login',
    authLimit(),
    wrap(async (req, res) => {
      const b = req.body ?? {};
      res.json(await auth.login(str(b.identifier).trim(), str(b.password)));
    }),
  );

  r.post(
    '/auth/forgot',
    authLimit(),
    wrap(async (req, res) => {
      await auth.forgot(str(req.body?.identifier).trim()).catch((err) => console.error('[auth] forgot error:', err));
      res.json({ ok: true });
    }),
  );

  r.post(
    '/auth/reset',
    authLimit(),
    wrap(async (req, res) => {
      if (auth.mode !== 'dev') throw new HttpError(404, MSG.notSupported);
      await auth.devReset(str(req.body?.token), str(req.body?.password));
      res.json({ ok: true });
    }),
  );

  r.post(
    '/auth/refresh',
    limiter(15 * 60_000, 100),
    wrap(async (req, res) => {
      if (auth.mode !== 'dev') throw new HttpError(404, MSG.notSupported);
      res.json(await auth.devRefresh(str(req.body?.refresh_token)));
    }),
  );

  r.get(
    '/me',
    wrap(async (req, res) => {
      const user = await requireUser(req);
      res.json(await me(user));
    }),
  );

  // Create profile (first Google login)
  r.post(
    '/profile',
    limiter(60_000, 30),
    wrap(async (req, res) => {
      const user = await requireUser(req);
      const username = str(req.body?.username).trim();
      assertUsername(username);
      if (await store.getProfile(user.userId)) throw new HttpError(409, MSG.profileExists);
      if (await store.isUsernameTaken(username, user.userId)) throw new HttpError(409, MSG.usernameTaken);
      try {
        await store.createProfile(user.userId, username, user.avatarUrl ?? null);
      } catch (err) {
        if (err instanceof UsernameTakenError) throw new HttpError(409, MSG.usernameTaken);
        throw err;
      }
      res.json(await me(user));
    }),
  );

  // Rename
  r.patch(
    '/profile',
    limiter(60_000, 30),
    wrap(async (req, res) => {
      const user = await requireUser(req);
      const username = str(req.body?.username).trim();
      assertUsername(username);
      const current = await store.getProfile(user.userId);
      if (!current) throw new HttpError(404, MSG.profileMissing);
      if (current.username !== username) {
        if (await store.isUsernameTaken(username, user.userId)) throw new HttpError(409, MSG.usernameTaken);
        try {
          await store.renameProfile(user.userId, username);
        } catch (err) {
          if (err instanceof UsernameTakenError) throw new HttpError(409, MSG.usernameTaken);
          throw err;
        }
        deps.onRename?.(user.userId, username);
      }
      res.json(await me(user));
    }),
  );

  r.use((_req, res) => {
    res.status(404).json({ error: MSG.notFound });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed' || e?.type === 'entity.too.large' || e?.status === 400) {
      return res.status(e.status ?? 400).json({ error: MSG.badRequest });
    }
    console.error('[api] error:', err);
    res.status(500).json({ error: MSG.server });
  });

  return r;
}
