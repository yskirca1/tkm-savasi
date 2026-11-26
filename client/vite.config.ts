import { defineConfig } from 'vite';

// Dev: Vite on :5173 proxies API + websockets to the game server on :3001.
// Prod: the game server serves client/dist itself (same origin).
export default defineConfig({
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
