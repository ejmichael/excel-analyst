import 'dotenv/config';
import { createApp } from './app.js';
import { env, loadEnv } from './config/env.js';
import { logger } from './lib/logger.js';

try {
  loadEnv();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const { PORT, NODE_ENV } = env();
createApp().listen(PORT, () => {
  logger.info({ port: PORT, env: NODE_ENV }, 'server listening');
});
