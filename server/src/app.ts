import cors from 'cors';
import express, { Router, type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { httpLogger } from './lib/logger.js';
import { requireAuth } from './middleware/auth.js';
import { requireConsent } from './middleware/consent.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { ipRateLimit, userRateLimit } from './middleware/rateLimit.js';
import { healthRouter } from './routes/health.js';
import { meRouter } from './routes/me.js';
import { workspacesRouter } from './routes/workspaces.js';

export function createApp(): Express {
  const config = env();
  const app = express();

  app.disable('x-powered-by');
  // Behind Render/Railway's proxy the client IP is in X-Forwarded-For (needed for per-IP limits).
  if (config.NODE_ENV === 'production') app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: config.CLIENT_URL }));
  app.use(httpLogger);
  app.use(express.json({ limit: '100kb' }));
  app.use(ipRateLimit);

  const v1 = Router();
  v1.use(healthRouter);

  // Everything below needs a valid Supabase access token.
  v1.use(requireAuth, userRateLimit);
  v1.use(meRouter); // allowed before consent

  // Everything below also needs consent (profiles.popia_consent_at).
  v1.use(requireConsent);
  v1.use(workspacesRouter);

  app.use('/api/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
