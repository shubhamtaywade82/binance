import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  server: {
    port: 5173,
    host: true,
    open: false,
  },
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
  },
});
