import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { configureApiClient } from '@/api/client';
import type { ColumnDataType, ColumnSemantic, DatasetColumn, DatasetDetail } from '@/api/types';

/** A column for tests; `sql_name` is the name in lower case. */
export function column(name: string, data_type: ColumnDataType, extra: Partial<DatasetColumn> = {}): DatasetColumn {
  return {
    id: `col-${name}`,
    position: 0,
    name,
    display_name: null,
    sql_name: name.toLowerCase().replace(/\W+/g, '_'),
    data_type,
    semantic: 'none' as ColumnSemantic,
    is_pii: false,
    vat_included: null,
    null_count: 0,
    distinct_count: 1,
    min_value: null,
    max_value: null,
    sample_values: [],
    ...extra,
  };
}

export function dataset(extra: Partial<DatasetDetail> = {}): DatasetDetail {
  return {
    id: 'd1',
    workspace_id: 'w1',
    name: 'Card sales',
    original_filename: 'card_sales.csv',
    file_type: 'csv',
    size_bytes: 2048,
    row_count: 25,
    status: 'ready',
    error_message: null,
    error_details: null,
    warnings: [],
    expires_at: null,
    created_at: '2026-11-19T09:00:00+02:00',
    columns: [column('Store', 'text'), column('Amount', 'decimal', { semantic: 'currency_zar' })],
    parse_options: { delimiter: ';', header_row: 1, decimal_separator: ',', date_format: 'dmy' },
    sheet_names: [],
    preamble_lines: [],
    excluded_rows: 0,
    suggestions: [],
    ...extra,
  };
}

type Reply = { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/**
 * A fake API: every request is recorded (as a URL); `answer` decides the reply. A reply can be a promise, so a test
 * can hold one response back and release it later.
 */
export function fakeApi(answer: (url: URL) => Reply) {
  const requests: URL[] = [];
  configureApiClient({
    getAccessToken: async () => 'token',
    refreshAccessToken: async () => null,
    transport: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed);
      const { status = 200, body } = await answer(parsed);
      return new Response(JSON.stringify(status < 300 ? { data: body } : { error: body }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  return requests;
}

/** Renders a tab at a URL inside a router, with a fresh query cache (no retries). */
export function renderAt(element: ReactElement, path = '/datasets/d1/data') {
  const router = createMemoryRouter(
    [
      { path: '/datasets/:id/:tab', element },
      { path: '*', element: <p>Elsewhere</p> },
    ],
    { initialEntries: [path] },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
