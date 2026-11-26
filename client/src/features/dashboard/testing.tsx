import { StrictMode, type ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { configureApiClient } from '@/api/client';
import type { ChartSpec, Dashboard, DashboardData, DashboardWidget, WidgetResult } from '@/api/types';
import { SessionProvider } from '@/auth/SessionProvider';
import { signedIn } from '@/test/session';

export function chart(type: ChartSpec['type'], x: string | null, y: string[], value_format: ChartSpec['value_format'] = {}): ChartSpec {
  return { type, x, y, series: null, orientation: 'vertical', stacked: false, value_format };
}

export function widget(id: string, extra: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    id,
    position: 1,
    title: `Widget ${id}`,
    width: 'quarter',
    sql: `SELECT count(*) AS n FROM data -- ${id}`,
    chart: chart('kpi', null, ['n'], { n: 'integer' }),
    ...extra,
  };
}

export function dashboard(extra: Partial<Dashboard> = {}): Dashboard {
  return {
    id: 'dash1',
    dataset_id: 'd1',
    status: 'ready',
    error_message: null,
    fallback: false,
    reading: { text: 'card sales, one row per sale, with amounts in rand', date_column: 'date' },
    filters: [
      { id: 'date', kind: 'date_range', column: 'date', label: 'Sale date', options: [], min: '2026-10-01', max: '2026-10-31' },
      { id: 'cat:store', kind: 'category', column: 'store', label: 'Store', options: ['Durban', 'Pretoria', 'Sandton'], min: null, max: null },
    ],
    widgets: [widget('w1', { title: 'Sales' })],
    created_at: '2026-11-20T09:00:00+02:00',
    ...extra,
  };
}

export function result(widgetId: string, extra: Partial<WidgetResult> = {}): WidgetResult {
  return {
    widget_id: widgetId,
    columns: [{ name: 'n', format: 'integer' }],
    rows: [{ n: 25 }],
    total_rows: 1,
    truncated: false,
    checks: [{ type: 'sql_read_only', ok: true, label: 'The query only reads your file' }],
    error: null,
    ...extra,
  };
}

export function data(widgets: WidgetResult[], extra: Partial<DashboardData> = {}): DashboardData {
  return { rows_total: 25, rows_in_scope: 25, widgets, ...extra };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Reply = { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/** A fake API recording each call's method, path (without /api/v1) and JSON body. */
export function fakeCalls(answer: (call: Call) => Reply) {
  const calls: Call[] = [];
  configureApiClient({
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => null,
    transport: async (url, init) => {
      const call: Call = {
        method: init.method ?? 'GET',
        path: new URL(url).pathname.replace(/^\/api\/v1/, ''),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const { status = 200, body } = await answer(call);
      return new Response(JSON.stringify(status < 300 ? { data: body } : { error: body }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  return {
    calls,
    plans: () => calls.filter((c) => c.method === 'POST' && c.path === '/datasets/d1/dashboard'),
    gets: () => calls.filter((c) => c.method === 'GET' && c.path === '/datasets/d1/dashboard'),
    dataCalls: () => calls.filter((c) => c.path === '/datasets/d1/dashboard/data'),
  };
}

/** Renders the tab, signed in, inside a router (a second route to leave it), optionally in React strict mode. */
export function renderTab(element: ReactElement, { path = '/datasets/d1/dashboard', strict = false } = {}) {
  const router = createMemoryRouter(
    [
      { path: '/datasets/:id/:tab', element },
      { path: '*', element: <p>Elsewhere</p> },
    ],
    { initialEntries: [path] },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (
    <QueryClientProvider client={client}>
      <SessionProvider backend={signedIn}>
        <RouterProvider router={router} />
      </SessionProvider>
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return { router, client };
}

/** The ?filters= value of the router's current URL, parsed. */
export function urlFilters(router: { state: { location: { search: string } } }): unknown {
  const raw = new URLSearchParams(router.state.location.search).get('filters');
  return raw ? JSON.parse(raw) : null;
}
