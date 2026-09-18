import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .tsx too, so a component whose whole job is rendering can be tested by
    // rendering it (Prose). Still `environment: 'node'` — these use
    // `renderToStaticMarkup`, not a DOM.
    include: ['{apps,packages}/*/src/**/*.test.ts', '{apps,packages}/*/src/**/*.test.tsx'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Integration tests hit Supabase over the network; the default 5s is tight.
    testTimeout: 15_000,
  },
});
