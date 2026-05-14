import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  server: {
    port: 5173,
    host: true,
    open: false,
    proxy: {
      // Browser → Vite (same port as UI); Vite forwards to the bot on 4001. Fixes WSL2 + Windows
      // where the dashboard binds 127.0.0.1:4001 and ws://localhost:4001 never reaches the VM.
      '/__dashboard_ws': {
        target: 'http://127.0.0.1:4001',
        changeOrigin: true,
        ws: true,
        rewrite: () => '/',
      },
      // NanoPine scripts REST API — same dashboard process, plain HTTP.
      '/api': {
        target: 'http://127.0.0.1:4001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
  },
});
