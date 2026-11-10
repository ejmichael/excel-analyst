import { describeError, sweepLeftoverTestUsers } from './helpers.js';

/** `npm run test:cleanup`: delete every leftover test user (test+<12 hex>@example.com) and their files, whatever their age. */
sweepLeftoverTestUsers(0)
  .then((n) => console.log(`removed ${n} leftover test user(s)`))
  .catch((err: unknown) => {
    console.error(`cleanup failed: ${describeError(err)}`);
    process.exit(1);
  });
