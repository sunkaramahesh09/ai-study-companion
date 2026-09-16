import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // Integration tests hit Supabase over the network; the default 5s is tight.
    testTimeout: 15_000,
  },
});
