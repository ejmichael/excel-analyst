import { Router } from 'express';
import { z } from 'zod';
import { AppError, notFound, throwIfDbError } from '../lib/errors.js';
import { authOf, ok } from '../lib/http.js';
import { supabaseAdmin, supabaseForUser } from '../lib/supabase.js';
import { requireUuidParam, validate } from '../middleware/validate.js';
import { deleteWorkspaceFiles } from '../services/files.js';
import { assertWithinLimit } from '../services/limits.js';
import type { CreateWorkspaceRequest, Deleted, UpdateWorkspaceRequest, Workspace } from '../types/api.js';

const WORKSPACE_COLUMNS = 'id, name, is_default, created_at';

const nameBody = z.strictObject({ name: z.string().trim().min(1).max(80) });

export const workspacesRouter = Router();

workspacesRouter.get('/workspaces', async (req, res) => {
  const { userId, token } = authOf(req);
  const { data, error } = await supabaseForUser(token)
    .from('workspaces')
    .select(WORKSPACE_COLUMNS)
    .eq('owner_id', userId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true })
    .returns<Workspace[]>();
  throwIfDbError('workspaces: list', error);
  ok(res, data ?? []);
});

workspacesRouter.post('/workspaces', validate({ body: nameBody }), async (req, res) => {
  const { userId } = authOf(req);
  const body = req.body as CreateWorkspaceRequest;
  await assertWithinLimit(userId, 'max_workspaces');
  const { data, error } = await supabaseAdmin()
    .from('workspaces')
    .insert({ owner_id: userId, name: body.name, is_default: false })
    .select(WORKSPACE_COLUMNS)
    .single<Workspace>();
  throwIfDbError('workspaces: create', error);
  ok(res, data, 201);
});

workspacesRouter.patch('/workspaces/:id', requireUuidParam(), validate({ body: nameBody }), async (req, res) => {
  const { userId } = authOf(req);
  const body = req.body as UpdateWorkspaceRequest;
  const { data, error } = await supabaseAdmin()
    .from('workspaces')
    .update({ name: body.name })
    .eq('id', req.params.id)
    .eq('owner_id', userId)
    .select(WORKSPACE_COLUMNS)
    .maybeSingle<Workspace>();
  throwIfDbError('workspaces: rename', error);
  if (!data) throw notFound('Workspace not found.');
  ok(res, data);
});

workspacesRouter.delete('/workspaces/:id', requireUuidParam(), async (req, res) => {
  const { userId, token } = authOf(req);
  const id = req.params.id as string;
  const { data: ws, error: readError } = await supabaseForUser(token)
    .from('workspaces')
    .select('id, is_default')
    .eq('id', id)
    .eq('owner_id', userId)
    .maybeSingle<{ id: string; is_default: boolean }>();
  throwIfDbError('workspaces: read for delete', readError);
  if (!ws) throw notFound('Workspace not found.');
  if (ws.is_default) throw new AppError('conflict', 'Your default workspace cannot be deleted.');

  // Files first: the cascade below removes the dataset rows that hold the storage paths.
  await deleteWorkspaceFiles(userId, id);
  const { error } = await supabaseAdmin().from('workspaces').delete().eq('id', id).eq('owner_id', userId);
  throwIfDbError('workspaces: delete', error);
  const deleted: Deleted = { deleted: true };
  ok(res, deleted);
});
