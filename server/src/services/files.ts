import { throwIfDbError } from '../lib/errors.js';
import { removeObjects } from '../lib/storage.js';
import { supabaseAdmin } from '../lib/supabase.js';

/**
 * Deletes every storage object belonging to a workspace (raw uploads and normalised files).
 * Must run before the workspace row is deleted, because the cascade removes the dataset rows that hold the paths.
 */
export async function deleteWorkspaceFiles(ownerId: string, workspaceId: string): Promise<void> {
  const { data, error } = await supabaseAdmin()
    .from('datasets')
    .select('storage_path, normalised_path')
    .eq('owner_id', ownerId)
    .eq('workspace_id', workspaceId)
    .returns<Array<{ storage_path: string; normalised_path: string | null }>>();
  throwIfDbError('files: list workspace datasets', error);
  await removeObjects((data ?? []).flatMap((d) => [d.storage_path, d.normalised_path]));
}
