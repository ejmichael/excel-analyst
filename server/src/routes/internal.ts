import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError, throwIfDbError } from '../lib/errors.js';
import { ok } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { removeObjects } from '../lib/storage.js';
import { supabaseAdmin } from '../lib/supabase.js';

export const internalRouter = Router();

const digest = (s: string) => createHash('sha256').update(s).digest();

/** x-cron-secret compared in constant time. The route does not exist while CRON_SECRET is unset. */
const requireCronSecret: RequestHandler = (req, _res, next) => {
  const secret = env().CRON_SECRET;
  if (!secret) throw new AppError('not_found', 'This route does not exist.');
  const given = req.get('x-cron-secret') ?? '';
  if (!timingSafeEqual(digest(given), digest(secret))) throw new AppError('unauthorized', 'Wrong or missing cron secret.');
  next();
};

const BATCH = 500;

/** Retention (ARCHITECTURE 7): remove the files of expired datasets and mark them `expired`. Blocks are kept. */
export async function purgeExpired(now = new Date()): Promise<number> {
  const admin = supabaseAdmin();
  let purged = 0;
  for (;;) {
    const { data, error } = await admin
      .from('datasets')
      .select('id, owner_id, storage_path, normalised_path')
      .in('status', ['ready', 'failed'])
      .lt('expires_at', now.toISOString())
      .limit(BATCH)
      .returns<Array<{ id: string; owner_id: string; storage_path: string; normalised_path: string | null }>>();
    throwIfDbError('purge: list', error);
    if (!data || data.length === 0) break;
    await removeObjects(data.flatMap((d) => [d.storage_path, d.normalised_path]));
    const { data: updated, error: updError } = await admin
      .from('datasets')
      .update({ status: 'expired' })
      .in('id', data.map((d) => d.id))
      .in('status', ['ready', 'failed'])
      .select('id');
    throwIfDbError('purge: mark expired', updError);
    purged += updated?.length ?? 0;
    if (data.length < BATCH) break;
  }
  logger.info({ purged }, 'purged expired datasets');
  return purged;
}

internalRouter.post('/internal/purge-expired', requireCronSecret, async (_req, res) => {
  ok(res, { purged: await purgeExpired() });
});
