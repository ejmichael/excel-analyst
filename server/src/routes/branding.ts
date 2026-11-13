import { type Request, type Response, Router } from 'express';
import multer from 'multer';
import { AppError, throwIfDbError } from '../lib/errors.js';
import { authOf, ok } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { buildBrand, LOGO_EXTENSIONS, logoPath, putLogo, removeLogos } from '../services/brand.js';
import { assertWithinLimit } from '../services/limits.js';
import { checkLogo, LOGO_LIMITS } from '../services/logo.js';

/**
 * POST /me/logo and DELETE /me/logo (slice S3). Both need limits.branding. The file type comes from the bytes only;
 * the object path is built from the owner id only (`<owner_id>/logo.<ext>`), never from anything the client sent.
 * Never logs the logo content.
 */
export const brandingRouter = Router();

const REFUSED: Record<Exclude<ReturnType<typeof checkLogo>, { ok: true }>['reason'], AppError> = {
  too_large: new AppError('file_too_large', 'The logo can be at most 1 MB.'),
  svg: new AppError('file_unsupported', 'SVG logos are not accepted. Upload a PNG, JPEG or WebP image.'),
  gif: new AppError('file_unsupported', 'GIF logos are not accepted. Upload a PNG, JPEG or WebP image.'),
  unsupported: new AppError('file_unsupported', 'Upload the logo as a PNG, JPEG or WebP image.'),
  damaged: new AppError('file_unsupported', 'This image looks damaged or incomplete. Save it again and upload it.'),
  too_big_dimensions: new AppError('validation_failed', `The logo can be at most ${LOGO_LIMITS.maxSide} pixels wide and high.`, {
    fields: [{ location: 'body', path: 'file', message: `At most ${LOGO_LIMITS.maxSide} × ${LOGO_LIMITS.maxSide} pixels.` }],
  }),
  too_small_dimensions: new AppError('validation_failed', `The logo must be at least ${LOGO_LIMITS.minSide} pixels wide and high.`, {
    fields: [{ location: 'body', path: 'file', message: `At least ${LOGO_LIMITS.minSide} × ${LOGO_LIMITS.minSide} pixels.` }],
  }),
};

/** Reads one file of at most 1 MB from the "file" field; a bigger one stops the read and answers 413. */
function receive(req: Request, res: Response): Promise<void> {
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { files: 1, fields: 0, parts: 2, fileSize: LOGO_LIMITS.maxBytes },
  }).single('file');
  return new Promise((resolve, reject) => {
    handler(req, res, (err: unknown) => {
      if (!err) return resolve();
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return reject(REFUSED.too_large);
        return reject(new AppError('validation_failed', 'Send one image in the "file" field.'));
      }
      return reject(new AppError('validation_failed', 'Send the logo as multipart/form-data.'));
    });
  });
}

interface BrandRow {
  business_name: string | null;
  brand_color: string;
  brand_logo_path: string | null;
}

async function setLogoPath(userId: string, path: string | null): Promise<BrandRow> {
  const { data, error } = await supabaseAdmin()
    .from('profiles')
    .update({ brand_logo_path: path })
    .eq('id', userId)
    .select('business_name, brand_color, brand_logo_path')
    .single<BrandRow>();
  throwIfDbError('branding: profile', error);
  return data!;
}

brandingRouter.post('/me/logo', async (req, res) => {
  const { userId } = authOf(req);
  await assertWithinLimit(userId, 'branding');
  await receive(req, res);
  const file = req.file;
  if (!file) throw new AppError('validation_failed', 'Choose an image to upload.', { fields: [{ location: 'body', path: 'file', message: 'Required.' }] });

  const check = checkLogo(file.buffer);
  if (!check.ok) throw REFUSED[check.reason];

  const path = logoPath(userId, check.ext);
  await putLogo(path, file.buffer, check.contentType);
  const profile = await setLogoPath(userId, path);
  // A logo saved earlier with another extension is removed so only one logo exists per owner.
  await removeLogos(LOGO_EXTENSIONS.filter((e) => e !== check.ext).map((e) => logoPath(userId, e)));
  logger.info({ bytes: file.size, width: check.width, height: check.height, ext: check.ext }, 'logo uploaded');
  ok(res, await buildBrand(profile));
});

brandingRouter.delete('/me/logo', async (req, res) => {
  const { userId } = authOf(req);
  await assertWithinLimit(userId, 'branding');
  await removeLogos(LOGO_EXTENSIONS.map((e) => logoPath(userId, e)));
  ok(res, await buildBrand(await setLogoPath(userId, null)));
});
