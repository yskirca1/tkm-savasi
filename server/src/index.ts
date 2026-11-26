import { loadConfig, loadDotenv, ROOT_DIR } from './config.js';

loadDotenv();

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { createApiRouter } from './auth/routes.js';
import { DevAuthProvider } from './auth/dev.js';
import { SupabaseAuthProvider, createAdminClient } from './auth/supabase.js';
import { GuestAuth } from './auth/guest.js';
import type { AuthProvider } from './auth/types.js';
import { DevDb } from './db/devdb.js';
import { DevStore } from './db/dev.js';
import { SupabaseStore } from './db/supabase.js';
import type { Store } from './db/types.js';
import { RoomManager } from './game/RoomManager.js';
import { realScheduler } from './game/scheduler.js';
import { createSocketTransport, registerSocketHandlers, type GameServer } from './game/socket.js';
import { sim } from './sim/index.js';

const config = loadConfig();

let auth: AuthProvider;
let store: Store;
let devDb: DevDb | null = null;
if (config.mode === 'supabase') {
  const admin = createAdminClient(config.supabaseUrl!, config.supabaseServiceRoleKey!);
  store = new SupabaseStore(admin);
  auth = new SupabaseAuthProvider(admin, store, {
    url: config.supabaseUrl!,
    anonKey: config.supabaseAnonKey!,
    appUrl: config.appUrl,
  });
  console.log(`[server] mode: supabase (${config.supabaseUrl}), google login ${config.googleEnabled ? 'enabled' : 'disabled'}`);
} else {
  devDb = new DevDb(config.devDataFile);
  store = new DevStore(devDb);
  auth = new DevAuthProvider(devDb, store, { secret: config.devJwtSecret, appUrl: config.appUrl });
  console.log(`[server] mode: dev (data: ${path.relative(ROOT_DIR, config.devDataFile)}; Supabase env not set)`);
  if (config.isProduction) console.warn('[server] WARNING: running dev mode in production — set SUPABASE_* env vars');
}
console.log(`[server] units per type: ${config.unitsPerType}`);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

const server = http.createServer(app);
const io: GameServer = new Server(server, {
  cors: config.isProduction ? undefined : { origin: config.appUrl, credentials: true },
  maxHttpBufferSize: 16 * 1024,
});

const rooms = new RoomManager({
  sim,
  scheduler: realScheduler,
  transport: createSocketTransport(io),
  unitsPerType: config.unitsPerType,
  saveMatch: (m) => store.saveMatch(m),
});
const guest = new GuestAuth(config.guestJwtSecret);
registerSocketHandlers(io, { auth, guest, store, rooms });

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, mode: config.mode, rooms: rooms.rooms.size });
});

app.use(
  '/api',
  createApiRouter({
    config,
    auth,
    guest,
    store,
    onRename: (userId, username) => rooms.renameUser(userId, username),
  }),
);

// Production: serve the built client with SPA fallback.
const clientDist = path.join(ROOT_DIR, 'client', 'dist');
if (config.isProduction && fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/|\/socket\.io\/).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
  console.log(`[server] serving client from ${path.relative(ROOT_DIR, clientDist)}`);
} else if (config.isProduction) {
  console.warn('[server] client/dist not found — run `npm run build` first');
}

server.listen(config.port, () => {
  console.log(`[server] listening on http://localhost:${config.port}`);
});

const shutdown = () => {
  devDb?.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
