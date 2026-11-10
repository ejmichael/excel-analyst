import 'dotenv/config';
import { createApp } from './app.js';
import { env, loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';
import { sweepInterruptedProfiling } from './services/profiling.js';

try {
  loadEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const { PORT, NODE_ENV, LLM_PROVIDER } = env();

// Jobs run in-process, so anything still `profiling` was cut off by the last restart.
try {
  const swept = await sweepInterruptedProfiling();
  if (swept > 0) logger.warn({ swept }, 'marked interrupted profiling jobs as failed');
} catch {
  logger.error('boot sweep failed');
}

createApp().listen(PORT, () => {
  logger.info({ port: PORT, env: NODE_ENV, llm_provider: LLM_PROVIDER }, 'server listening');
});
