import { configDefaults, defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that one roots Vite at src/web, but tests
// live across src/. Only src/ is tested; spikes/ is a separate package with no tests.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'spikes/**'],
    environment: 'node',
  },
});
