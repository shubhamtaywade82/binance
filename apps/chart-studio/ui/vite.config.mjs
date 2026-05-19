import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@chart-studio/indicator-runtime': path.resolve(here, '../packages/indicator-runtime/src/index.ts'),
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: process.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:4100',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      '/ws': {
        target: (process.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:4100').replace(/^http/, 'ws'),
        ws: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
