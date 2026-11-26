import { defineConfig } from 'vite';

// Dev: Vite on :5173 proxies API + websockets to the game server on :3001.
// Prod: the game server serves client/dist itself (same origin).
// VITE_API_TARGET / VITE_PORT let a second dev instance run beside the default one.
const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:3001';
const devPort = Number(process.env.VITE_PORT ?? 5173);

export default defineConfig({
  server: {
    port: devPort,
    host: true,
    proxy: {
      '/api': apiTarget,
      '/socket.io': { target: apiTarget, ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
