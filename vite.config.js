import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const workspaceRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'ui',
  resolve: {
    alias: {
      '@coindcx/indicator-runtime': path.resolve(workspaceRoot, 'packages/indicator-runtime/src'),
    },
    extensions: ['.mjs', '.js', '.ts', '.jsx', '.tsx', '.json'],
  },
  server: {
    port: 5173,
    host: true,
    open: false,
    fs: {
      allow: [
        workspaceRoot,
      ],
    },
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
