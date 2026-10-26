import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5179,
    strictPort: true,
    // During parallel panel development a transient syntax error in one panel
    // must not paint the full-screen Vite error overlay over the console; the
    // UI root isolates the failing panel and logs the error instead.
    hmr: {
      overlay: false,
    },
  },
  // The repo keeps QA / design-preview HTML fixtures under artifacts/. Only the
  // app entry point should be scanned for dependency pre-bundling, otherwise a
  // syntax error in a throwaway preview page would break the dev server.
  optimizeDeps: {
    entries: ['index.html'],
  },
  build: {
    // `es2022` is required for the top-level await in src/main.js that preloads
    // the local HDR sky panorama before the scene is assembled (so the very
    // first frame already has the HDR atmosphere). es2022 is supported by all
    // evergreen browsers (Chrome/Edge 94+, Firefox 93+, Safari 15.4+).
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
