import { z } from 'zod';
import type { ApiError, ErrorCode, PlanLimitDetails, Workspace } from '../types';
import type { Transport, UploadTransport } from '../client';
import { buildMe, cheapestPlanAllowing, sastTimestamp, type MockUser } from './data';
import { routeBlocks } from './blocks';
import { handleLogoUpload, routeLogoDelete, routeReports } from './reports';
import { datasetSnapshot, handleUpload, routeDatasets } from './datasets';
import { mockStore } from './store';

/**
 * A fetch-compatible transport that behaves like the contract for the Part 1 endpoints:
 * consent gating, one default workspace, 402 on a second workspace on Free, 409 on deleting the default.
 * It returns real Response objects, so apiFetch runs exactly the same code in mock and real mode.
 */

let latencyMs = 250;
export function setMockLatency(ms: number): void {
  latencyMs = ms;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function ok<T>(data: T, status = 200): Response {
  return json(status, { data });
}

function fail(status: number, code: ErrorCode, message: string, details?: unknown): Response {
  const body: ApiError = { error: { code, message, ...(details === undefined ? {} : { details }) } };
  return json(status, body);
}

// Same rules as the server's zod schemas (server/src/routes/me.ts and workspaces.ts).
const optionalName = z.string().trim().min(1).max(120).nullable().optional();
const updateMeSchema = z.strictObject({
  full_name: optionalName,
  business_name: optionalName,
  brand_color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  accept_terms: z.literal(true).optional(),
});
const workspaceNameSchema = z.strictObject({ name: z.string().trim().min(1).max(80) });

function validationFailed(error: z.ZodError): Response {
  const fields = error.issues.map((issue) => ({
    location: 'body',
    path: issue.path.join('.'),
    message: issue.message,
  }));
  return fail(422, 'validation_failed', 'Some fields are not valid.', { fields });
}

function sortWorkspaces(list: Workspace[]): Workspace[] {
  return [...list].sort((a, b) =>
    a.is_default === b.is_default ? a.created_at.localeCompare(b.created_at) : a.is_default ? -1 : 1,
  );
}

function route(method: string, path: string, user: MockUser, body: unknown): Response {
  if (path === '/me' && method === 'GET') return ok(buildMe(user));

  if (path === '/me' && method === 'PATCH') {
    const parsed = updateMeSchema.safeParse(body ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const input = parsed.data;
    if (input.brand_color !== undefined && !buildMe(user).limits.branding) {
      const details: PlanLimitDetails = {
        limit_key: 'branding',
        limit: 0,
        used: 0,
        upgrade_to: cheapestPlanAllowing((l) => l.branding),
      };
      return fail(402, 'plan_limit', 'Branding is not included in your plan.', details);
    }
    if (input.full_name !== undefined) user.full_name = input.full_name;
    if (input.business_name !== undefined) user.business_name = input.business_name;
    if (input.brand_color !== undefined) user.brand_color = input.brand_color.toUpperCase();
    if (input.accept_terms && !user.popia_consent_at) user.popia_consent_at = sastTimestamp();
    mockStore.save();
    return ok(buildMe(user));
  }

  // Everything below needs consent.
  if (!user.popia_consent_at) {
    return fail(403, 'consent_required', 'Accept the terms and privacy notice first.');
  }

  if (path === '/workspaces' && method === 'GET') return ok(sortWorkspaces(user.workspaces));

  if (path === '/workspaces' && method === 'POST') {
    const parsed = workspaceNameSchema.safeParse(body ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const limits = buildMe(user).limits;
    const used = user.workspaces.length;
    if (used >= limits.max_workspaces) {
      const details: PlanLimitDetails = {
        limit_key: 'max_workspaces',
        limit: limits.max_workspaces,
        used,
        upgrade_to: cheapestPlanAllowing((l) => l.max_workspaces > used),
      };
      return fail(402, 'plan_limit', 'Workspace limit reached.', details);
    }
    const workspace: Workspace = {
      id: crypto.randomUUID(),
      name: parsed.data.name,
      is_default: false,
      created_at: sastTimestamp(),
    };
    user.workspaces.push(workspace);
    mockStore.save();
    return ok(workspace, 201);
  }

  const match = /^\/workspaces\/([^/]+)$/.exec(path);
  if (match) {
    const id = decodeURIComponent(match[1] ?? '');
    const workspace = user.workspaces.find((w) => w.id === id);
    if (!workspace) return fail(404, 'not_found', 'Workspace not found.');

    if (method === 'PATCH') {
      const parsed = workspaceNameSchema.safeParse(body ?? {});
      if (!parsed.success) return validationFailed(parsed.error);
      workspace.name = parsed.data.name;
      mockStore.save();
      return ok(workspace);
    }
    if (method === 'DELETE') {
      if (workspace.is_default) return fail(409, 'conflict', 'The default workspace cannot be deleted.');
      user.workspaces = user.workspaces.filter((w) => w.id !== id);
      // Contract: deleting a workspace deletes its datasets too.
      user.datasets = (user.datasets ?? []).filter((ds) => ds.detail.workspace_id !== id);
      mockStore.save();
      return ok({ deleted: true as const });
    }
  }

  return fail(404, 'not_found', 'Not found.');
}

export const mockTransport: Transport = async (url, init) => {
  if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  const parsedUrl = new URL(url);
  const path = parsedUrl.pathname.replace(/^\/api\/v1/, '');
  const method = (init.method ?? 'GET').toUpperCase();
  const auth = new Headers(init.headers).get('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;

  if (path === '/health' && method === 'GET') return ok({ status: 'ok', time: sastTimestamp() });

  const user = mockStore.userByToken(token);
  if (!user) return fail(401, 'unauthorized', 'Missing or invalid token.');

  if (init.body instanceof FormData) {
    if (!user.popia_consent_at) return fail(403, 'consent_required', 'Accept the terms and privacy notice first.');
    if (path === '/me/logo' && method === 'POST') {
      const logo = await handleLogoUpload(user, init.body);
      mockStore.save();
      return json(logo.status, logo.body);
    }
    if (path !== '/datasets' || method !== 'POST') return fail(404, 'not_found', 'Not found.');
    const result = await handleUpload(user, init.body);
    mockStore.save();
    return json(result.status, result.body);
  }

  let body: unknown = undefined;
  if (typeof init.body === 'string') {
    try {
      body = JSON.parse(init.body);
    } catch {
      return fail(422, 'validation_failed', 'The request body is not valid JSON.');
    }
  }

  if (/^\/(datasets\/[^/]+\/(ask|blocks)$|blocks\/)/.test(path)) {
    if (!user.popia_consent_at) return fail(403, 'consent_required', 'Accept the terms and privacy notice first.');
    const result = await routeBlocks(method, parsedUrl, user, body, (id) => datasetSnapshot(user, id), latencyMs);
    mockStore.save();
    if (result?.raw) return result.raw;
    if (result) return new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json', ...result.headers } });
  }

  if (path === '/me/logo' && method === 'DELETE') {
    const result = routeLogoDelete(user);
    mockStore.save();
    return json(result.status, result.body);
  }

  if (path === '/reports' || path.startsWith('/reports/')) {
    if (!user.popia_consent_at) return fail(403, 'consent_required', 'Accept the terms and privacy notice first.');
    const result = routeReports(method, parsedUrl, user, body);
    mockStore.save();
    if (result) return json(result.status, result.body);
  }

  if (path.startsWith('/datasets')) {
    if (!user.popia_consent_at) return fail(403, 'consent_required', 'Accept the terms and privacy notice first.');
    const result = routeDatasets(method, parsedUrl, user, body);
    mockStore.save();
    if (result) return json(result.status, result.body);
  }
  return route(method, path, user, body);
};

/**
 * Mock upload: reports progress in steps the way XHR upload events would, honours Cancel,
 * then answers through the same mock routes.
 */
export const mockUploadTransport: UploadTransport = async (url, { form, headers, onProgress, signal }) => {
  const file = form.get('file');
  const size = file instanceof File ? file.size : 0;
  const steps = Math.min(10, Math.max(3, Math.ceil(size / 200_000)));
  for (let step = 1; step <= steps; step += 1) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, latencyMs === 0 ? 0 : 150);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('The upload was cancelled.', 'AbortError'));
        },
        { once: true },
      );
    });
    onProgress(step / steps);
  }
  return mockTransport(url, { method: 'POST', headers, body: form, signal });
};
