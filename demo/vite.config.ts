import { defineConfig } from 'vite';

export default defineConfig({
  base: '/BandEngine/',
  server: {
    host: true,
    port: 5173,
    https: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
