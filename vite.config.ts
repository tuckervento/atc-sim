import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The web app lives in src/web. Rooting Vite there (not at the repo root) keeps its
// HTML/dependency scan out of spikes/, which is a separate standalone package.
export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
});
