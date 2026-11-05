import { defineConfig } from 'vitest/config';

// `npm run test:db`: every test, on the real data/app.db. Run it after `npm run sync:cards`,
// `npm run sync:rules` and the steps that make your atoms, rules and builds.
export default defineConfig({
  test: { globals: true, environment: 'node', include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup-env.ts'] },
});
