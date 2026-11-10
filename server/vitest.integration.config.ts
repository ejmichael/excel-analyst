import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/** Integration tests: real Supabase, so files run one at a time and leftovers from earlier runs are swept first. */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      dir: 'test/integration',
      globalSetup: ['test/integration/globalSetup.ts'],
      fileParallelism: false,
      sequence: { concurrent: false },
    },
  }),
);
