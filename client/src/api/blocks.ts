import { apiDownload, apiFetch, type Download } from './client';
import type { Ack, AskRequest, Block, BlockFeedbackRequest, Deleted, ID, Paged, SourceRows } from './types';

/** POST /datasets/:id/ask (201 Block; synchronous, usually 4 to 9 s, up to about 30 s) */
export function askQuestion(datasetId: ID, body: AskRequest): Promise<Block> {
  return apiFetch<Block>(`/datasets/${encodeURIComponent(datasetId)}/ask`, { method: 'POST', body });
}

/** GET /datasets/:id/blocks?limit=&offset= (newest first) */
export function listBlocks(
  datasetId: ID,
  { limit, offset }: { limit: number; offset: number },
  signal?: AbortSignal,
): Promise<Paged<Block>> {
  return apiFetch<Paged<Block>>(`/datasets/${encodeURIComponent(datasetId)}/blocks?limit=${limit}&offset=${offset}`, {
    signal,
  });
}

/** GET /blocks/:id */
export function getBlock(id: ID, signal?: AbortSignal): Promise<Block> {
  return apiFetch<Block>(`/blocks/${encodeURIComponent(id)}`, { signal });
}

/** GET /blocks/:id/source-rows?limit=&offset= (eq_column / eq_value are not used in this part) */
export function getSourceRows(
  id: ID,
  { limit, offset }: { limit: number; offset: number },
  signal?: AbortSignal,
): Promise<SourceRows> {
  return apiFetch<SourceRows>(`/blocks/${encodeURIComponent(id)}/source-rows?limit=${limit}&offset=${offset}`, { signal });
}

/** GET /blocks/:id/export.csv (a file, not { data }; counts as an export) */
export function downloadBlockCsv(id: ID): Promise<Download> {
  return apiDownload(`/blocks/${encodeURIComponent(id)}/export.csv`);
}

/** POST /blocks/:id/feedback */
export function sendBlockFeedback(id: ID, body: BlockFeedbackRequest): Promise<Ack> {
  return apiFetch<Ack>(`/blocks/${encodeURIComponent(id)}/feedback`, { method: 'POST', body });
}

/** DELETE /blocks/:id (409 conflict while pinned in a report) */
export function deleteBlock(id: ID): Promise<Deleted> {
  return apiFetch<Deleted>(`/blocks/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
