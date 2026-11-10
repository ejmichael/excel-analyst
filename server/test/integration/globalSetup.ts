import { describeError, sweepLeftoverTestUsers } from './helpers.js';

/**
 * Before the integration run: delete test users (test+<12 hex>@example.com) older than an hour, left behind by a run
 * that was killed or lost its network mid-cleanup. Younger ones are left alone in case another run is in progress.
 */
export default async function setup(): Promise<void> {
  try {
    const removed = await sweepLeftoverTestUsers();
    if (removed > 0) console.warn(`[integration setup] removed ${removed} leftover test user(s) from earlier runs`);
  } catch (err) {
    console.warn(`[integration setup] leftover sweep skipped: ${describeError(err)}`);
  }
}
