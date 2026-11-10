import { env } from '../config/env.js';
import { supabaseAdmin } from './supabase.js';

/** Private `datasets` bucket helpers. Paths are built only from generated ids. Errors never include file content. */

export const rawPath = (ownerId: string, datasetId: string, ext: 'csv' | 'xlsx') => `${ownerId}/${datasetId}/raw.${ext}`;
export const normalisedPath = (ownerId: string, datasetId: string) => `${ownerId}/${datasetId}/normalised.csv`;

export class StorageError extends Error {
  constructor(readonly op: string) {
    super(`Storage error during ${op}`);
    this.name = 'StorageError';
  }
}

const bucket = () => supabaseAdmin().storage.from(env().STORAGE_BUCKET_DATASETS);

export async function putObject(path: string, body: Buffer, contentType: string): Promise<void> {
  const { error } = await bucket().upload(path, body, { contentType, upsert: true });
  if (error) throw new StorageError('upload');
}

export async function getObject(path: string): Promise<Buffer | null> {
  const { data, error } = await bucket().download(path);
  if (error) {
    // supabase-js reports a missing object as an error; treat it as "gone".
    const status = (error as { status?: number; statusCode?: string }).status;
    if (status === 400 || status === 404) return null;
    throw new StorageError('download');
  }
  return Buffer.from(await data.arrayBuffer());
}

export async function removeObjects(paths: Array<string | null | undefined>): Promise<void> {
  const list = paths.filter((p): p is string => Boolean(p));
  if (list.length === 0) return;
  for (let i = 0; i < list.length; i += 900) {
    const { error } = await bucket().remove(list.slice(i, i + 900));
    if (error) throw new StorageError('remove');
  }
}

export async function objectExists(path: string): Promise<boolean> {
  const slash = path.lastIndexOf('/');
  const { data, error } = await bucket().list(path.slice(0, slash), { search: path.slice(slash + 1) });
  if (error) throw new StorageError('list');
  return (data ?? []).some((o) => o.name === path.slice(slash + 1));
}
