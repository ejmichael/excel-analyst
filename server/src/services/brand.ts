import { env } from '../config/env.js';
import { StorageError } from '../lib/storage.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';
import type { Brand, Plan } from '../types/api.js';

/**
 * Branding (business name, colour, logo). The logo lives in the private `branding` bucket at `<owner_id>/logo.<ext>`;
 * the path is built from the owner id only, so a logo can never point at another user's file. The database stores the
 * path; the API only ever returns a signed URL, made fresh on every read and valid for 1 hour.
 */

export const LOGO_URL_TTL_SECONDS = 3600;
export const LOGO_EXTENSIONS = ['png', 'jpg', 'webp'] as const;
export type LogoExt = (typeof LOGO_EXTENSIONS)[number];

export const logoPath = (ownerId: string, ext: LogoExt) => `${ownerId}/logo.${ext}`;

/** Watermark on a report: the owner is on the free plan. */
export const watermarkFor = (plan: Plan) => plan === 'free';

const bucket = () => supabaseAdmin().storage.from(env().STORAGE_BUCKET_BRANDING);

/** A fresh signed URL, or null when there is no logo (or the object is gone). */
export async function signedLogoUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await bucket().createSignedUrl(path, LOGO_URL_TTL_SECONDS);
  if (error || !data) {
    // A missing object must not break /me or a report; the logo simply is not shown.
    logger.warn({ op: 'logo signed url' }, 'logo url could not be signed');
    return null;
  }
  return data.signedUrl;
}

export interface BrandSource {
  business_name: string | null;
  brand_color: string;
  brand_logo_path: string | null;
}

export async function buildBrand(p: BrandSource): Promise<Brand> {
  return { business_name: p.business_name, logo_url: await signedLogoUrl(p.brand_logo_path), color: p.brand_color };
}

export async function putLogo(path: string, body: Buffer, contentType: string): Promise<void> {
  const { error } = await bucket().upload(path, body, { contentType, upsert: true, cacheControl: '3600' });
  if (error) throw new StorageError('logo upload');
}

export async function removeLogos(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const { error } = await bucket().remove(paths);
  if (error) throw new StorageError('logo remove');
}
