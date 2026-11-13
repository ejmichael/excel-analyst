import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { configureApiClient, type Transport } from '@/api/client';
import { buildMe, newMockUser } from '@/api/mocks/data';
import { DELETED_FILE_MESSAGE, WORKSPACE_RULE_MESSAGE } from '@/api/mocks/reports';
import { SessionProvider } from '@/auth/SessionProvider';
import { signedIn } from '@/test/session';
import { CreateReportDialog, answersNamedIn, reportFieldErrors } from './CreateReportDialog';
import type { TrayItem } from './tray';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const items: TrayItem[] = [
  { block_id: 'b1', title: 'Net sales by store', dataset_id: 'd1', dataset_name: 'Card sales October' },
  { block_id: 'b2', title: 'Card fees', dataset_id: 'd1', dataset_name: 'Card sales October' },
  { block_id: 'b3', title: 'Stock count', dataset_id: 'd2', dataset_name: 'Stock' },
];

function setup(answer: (url: string, init: RequestInit) => Response | null) {
  const me = buildMe(newMockUser('owner@example.co.za', 'x'));
  me.usage.reports = 0;
  const requests: Array<{ url: string; body: unknown; method: string }> = [];
  const transport: Transport = async (url, init) => {
    requests.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith('/me')) return json(200, { data: me });
    return answer(url, init) ?? json(500, { error: { code: 'internal', message: 'x' } });
  };
  configureApiClient({ transport, getAccessToken: async () => 't', refreshAccessToken: async () => null, onUnauthorized: () => {} });
  const onDrop = vi.fn();
  const onCreated = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider backend={signedIn}>
      <MemoryRouter initialEntries={['/datasets']}>
        <Routes>
          <Route path="/datasets" element={<CreateReportDialog open workspaceId="w1" items={items} onClose={vi.fn()} onCreated={onCreated} onDrop={onDrop} />} />
          <Route path="/reports/:id" element={<p>Report page</p>} />
        </Routes>
      </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { requests, onDrop, onCreated };
}

describe('report field rules', () => {
  it('title 1 to 120, subtitle up to 200, period up to 60', () => {
    expect(reportFieldErrors({ title: ' ', subtitle: '', period_label: '' }).title).toBe('Give the report a title.');
    const long = reportFieldErrors({ title: 'x'.repeat(121), subtitle: 'x'.repeat(201), period_label: 'x'.repeat(61) });
    expect(long.title).toMatch(/120/);
    expect(long.subtitle).toMatch(/200/);
    expect(long.period_label).toMatch(/60/);
    expect(reportFieldErrors({ title: 'x'.repeat(120), subtitle: 'x'.repeat(200), period_label: 'x'.repeat(60) })).toEqual({});
  });

  it('finds the answers a 422 names by position', () => {
    expect(answersNamedIn({ 'block_ids.1': 'Other workspace', title: 'x' }, ['b1', 'b2'])).toEqual([{ block_id: 'b2', message: 'Other workspace' }]);
    expect(answersNamedIn({ 'blocks.0.block_id': 'Gone' }, ['b1'])).toEqual([{ block_id: 'b1', message: 'Gone' }]);
  });
});

describe('CreateReportDialog', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('defaults the title, shows the answer count and the monthly quota, and creates the report', async () => {
    const { requests, onCreated } = setup((url, init) =>
      url.endsWith('/reports') && init.method === 'POST' ? json(201, { data: { id: 'r1', workspace_id: 'w1' } }) : null,
    );
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('Card sales October report');
    expect(dialog).toHaveTextContent('3 answers');
    expect(await within(dialog).findByText('0 of 1 reports used this month')).toBeInTheDocument();

    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Period (optional)' }), 'October 2026');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create report' }));
    expect(await screen.findByText('Report page')).toBeInTheDocument();
    expect(onCreated).toHaveBeenCalled();
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      workspace_id: 'w1',
      title: 'Card sales October report',
      subtitle: null,
      period_label: 'October 2026',
      block_ids: ['b1', 'b2', 'b3'],
    });
  });

  it('shows the field error and does not send an empty title', async () => {
    const { requests } = setup(() => null);
    const dialog = screen.getByRole('dialog');
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Title' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create report' }));
    expect(within(dialog).getByText('Give the report a title.')).toBeInTheDocument();
    expect(requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('402 on the monthly report limit opens the upgrade dialog', async () => {
    setup(() => json(402, { error: { code: 'plan_limit', message: 'x', details: { limit_key: 'max_reports_per_month', limit: 1, used: 1, upgrade_to: 'solo' } } }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create report' }));
    expect(await screen.findByText('Your Free plan includes 1 report a month. You have used 1 this month.')).toBeInTheDocument();
  });

  it('422 for the workspace rule names each refused answer by its position, each with a way to remove it', async () => {
    // The real server's shape: one entry per refused answer, block_ids.<i>, i = position in the request.
    const { onDrop } = setup(() =>
      json(422, {
        error: {
          code: 'validation_failed',
          message: WORKSPACE_RULE_MESSAGE,
          details: {
            fields: [
              { location: 'body', path: 'block_ids.1', message: WORKSPACE_RULE_MESSAGE },
              { location: 'body', path: 'block_ids.2', message: DELETED_FILE_MESSAGE },
            ],
          },
        },
      }),
    );
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create report' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`“Card fees”: ${WORKSPACE_RULE_MESSAGE}`);
    expect(alert).toHaveTextContent(`“Stock count”: ${DELETED_FILE_MESSAGE}`);
    expect(within(alert).queryByText(/Net sales by store/)).not.toBeInTheDocument();

    await userEvent.click(within(alert).getByRole('button', { name: 'Remove it from the tray: Card fees' }));
    expect(onDrop).toHaveBeenLastCalledWith(['b2']);
    expect(screen.getByRole('alert')).toHaveTextContent(WORKSPACE_RULE_MESSAGE);
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Remove it from the tray: Stock count' }));
    expect(onDrop).toHaveBeenLastCalledWith(['b3']);
    // Nothing refused is left, so the message goes too.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('404 re-checks each answer and drops the one that no longer exists', async () => {
    const { onDrop } = setup((url, init) => {
      if (url.endsWith('/reports') && init.method === 'POST') return json(404, { error: { code: 'not_found', message: 'x' } });
      if (url.endsWith('/blocks/b1')) return json(200, { data: { id: 'b1' } });
      if (url.endsWith('/blocks/b2')) return json(404, { error: { code: 'not_found', message: 'x' } });
      return null;
    });
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Create report' }));
    expect(await screen.findByText(/One of these answers no longer exists, so it was removed from your tray: “Card fees”/)).toBeInTheDocument();
    expect(onDrop).toHaveBeenCalledWith(['b2']);
  });
});
