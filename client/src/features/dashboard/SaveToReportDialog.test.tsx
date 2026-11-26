import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildMe, newMockUser } from '@/api/mocks/data';
import type { Report, SaveDashboardToReportRequest } from '@/api/types';
import { dataset } from '@/features/datasets/workspace/testing';
import { reportKeys } from '@/features/reports/queries';
import { DashboardTab } from './DashboardTab';
import { MAX_SAVED_CHARTS, submitBlocker } from './saveToReport';
import { chart, dashboard, data, fakeCalls, renderTab, result, widget, type Call } from './testing';

const board = dashboard({
  widgets: [
    widget('w2', { title: 'Sales by store', position: 2, width: 'half', chart: chart('bar', 'store', ['n']) }),
    widget('w1', { title: 'Sales', position: 1 }),
    widget('w3', { title: 'Broken chart', position: 3 }),
  ],
});
const goodData = data([result('w1'), result('w2'), result('w3', { error: 'This chart could not be run.' })]);

const report = (id: string, title: string, extra: Partial<Report> = {}): Report => ({
  id,
  workspace_id: 'w1',
  title,
  subtitle: null,
  period_label: null,
  notes: null,
  template_id: null,
  block_count: 3,
  created_at: '2026-11-20T09:00:00+02:00',
  updated_at: '2026-11-21T09:00:00+02:00',
  ...extra,
});
const REPORTS = [report('r1', 'October review'), report('r2', 'Card fees', { block_count: 29 })];

const ME = buildMe(newMockUser('owner@example.co.za', 'x'));

type Reply = { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/** A server for the dashboard, its data, the reports list and /me; `save` answers the save request. */
function server({ save, reports = REPORTS, dash = board, widgets = goodData }: { save?: (call: Call) => Reply; reports?: Report[]; dash?: typeof board; widgets?: typeof goodData } = {}) {
  return fakeCalls((call) => {
    if (call.path.endsWith('/save-to-report')) return save ? save(call) : { status: 201, body: report('rNew', 'Card sales, dashboard') };
    if (call.path.endsWith('/data')) return { body: widgets };
    if (call.path === '/reports') return { body: { items: reports, total: reports.length, limit: 20, offset: 0 } };
    if (call.path === '/me') return { body: ME };
    return { body: dash };
  });
}

const saves = (api: { calls: Call[] }) => api.calls.filter((c) => c.path.endsWith('/save-to-report'));
const trigger = () => screen.getByRole('button', { name: 'Save to a report' });
const dialog = () => screen.getByRole('dialog', { name: 'Save to a report' });
const submit = () => within(dialog()).getByRole('button', { name: /^(Save to report|Saving…)$/ });

async function openDialog(path?: string) {
  const rendered = renderTab(<DashboardTab dataset={dataset()} />, path ? { path } : undefined);
  await waitFor(() => expect(trigger()).toBeEnabled());
  await userEvent.click(trigger());
  await screen.findByRole('dialog', { name: 'Save to a report' });
  return rendered;
}

async function chooseExisting(title: string) {
  await userEvent.click(within(dialog()).getByRole('radio', { name: 'Add to an existing report' }));
  await userEvent.click(await within(dialog()).findByRole('radio', { name: new RegExp(title) }));
}

describe('the "Save to a report" button', () => {
  it('is disabled with the reason while the dashboard is planning', async () => {
    server({ dash: dashboard({ status: 'planning', filters: [], widgets: [] }) });
    renderTab(<DashboardTab dataset={dataset()} />);
    await screen.findByText('Analyst is planning your dashboard');
    expect(trigger()).toBeDisabled();
    expect(trigger().parentElement).toHaveAttribute('title', 'The dashboard is still being planned.');
    expect(trigger()).toHaveAccessibleDescription('The dashboard is still being planned.');
  });

  it('is disabled when the dashboard failed', async () => {
    server({ dash: dashboard({ status: 'failed', error_message: 'Too few charts.', widgets: [] }) });
    renderTab(<DashboardTab dataset={dataset()} />);
    await screen.findByText('Analyst could not build a dashboard for this file');
    expect(trigger()).toBeDisabled();
    expect(trigger()).toHaveAccessibleDescription(/could not be built/);
  });

  it('is disabled when no chart works', async () => {
    server({ widgets: data([result('w1', { error: 'x' }), result('w2', { error: 'x' }), result('w3', { error: 'x' })]) });
    renderTab(<DashboardTab dataset={dataset()} />);
    await waitFor(() => expect(trigger()).toHaveAccessibleDescription('None of the charts can be saved right now: each one has an error.'));
    expect(trigger()).toBeDisabled();
  });

  it('is enabled once the charts are on screen', async () => {
    server();
    renderTab(<DashboardTab dataset={dataset()} />);
    await waitFor(() => expect(trigger()).toBeEnabled());
    expect(trigger().parentElement).not.toHaveAttribute('title');
  });
});

describe('the dialog: defaults, focus and choices', () => {
  it('opens on New report with the title filled in and every working chart ticked; a chart with an error is disabled', async () => {
    server();
    await openDialog();
    expect(within(dialog()).getByRole('radio', { name: 'New report' })).toBeChecked();
    expect(within(dialog()).getByRole('radio', { name: 'New report' })).toHaveFocus();
    expect(within(dialog()).getByRole('textbox', { name: 'Report title' })).toHaveValue('Card sales, dashboard');
    const boxes = within(dialog()).getAllByRole('checkbox');
    // Dashboard order, whatever the widgets' order in the response.
    expect(boxes.map((b) => b.getAttribute('aria-labelledby') ?? document.querySelector(`label[for="${b.id}"]`)?.textContent)).toEqual([
      expect.stringContaining('Sales'),
      expect.stringContaining('Sales by store'),
      expect.stringContaining('Broken chart'),
    ]);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeChecked();
    expect(boxes[2]).not.toBeChecked();
    expect(boxes[2]).toBeDisabled();
    expect(boxes[2]).toHaveAccessibleDescription('This chart has an error.');
    expect(within(dialog()).getByText('2 of 3 charts')).toBeInTheDocument();
    expect(within(dialog()).getByText('No filters. All rows.')).toBeInTheDocument();
  });

  it('Escape and Cancel close it, and focus goes back to the button', async () => {
    server();
    await openDialog();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
    await userEvent.click(trigger());
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger()).toHaveFocus();
  });

  it('keeps focus inside: Tab from the last control comes back to the first', async () => {
    server();
    await openDialog();
    for (let i = 0; i < 20; i++) {
      await userEvent.tab();
      expect(dialog().contains(document.activeElement)).toBe(true);
    }
  });

  it('counter, Clear and Select all; the button says why it is disabled', async () => {
    server();
    await openDialog();
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Clear' }));
    expect(within(dialog()).getByText('0 of 3 charts')).toBeInTheDocument();
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveAccessibleDescription('Pick at least one chart.');
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Select all' }));
    // The chart with an error is never selected.
    expect(within(dialog()).getByText('2 of 3 charts')).toBeInTheDocument();
    expect(submit()).toBeEnabled();
    await userEvent.click(within(dialog()).getAllByRole('checkbox')[0]!);
    expect(within(dialog()).getByText('1 of 3 charts')).toBeInTheDocument();
  });

  it('an empty title disables saving', async () => {
    server();
    await openDialog();
    await userEvent.clear(within(dialog()).getByRole('textbox', { name: 'Report title' }));
    expect(submit()).toBeDisabled();
    expect(submit()).toHaveAccessibleDescription('Give the report a title.');
  });

  it('1 to 30 charts', () => {
    const base = { target: 'new' as const, title: 'A', report: null };
    expect(submitBlocker({ ...base, selected: 0 })).toBe('Pick at least one chart.');
    expect(submitBlocker({ ...base, selected: 1 })).toBeNull();
    expect(submitBlocker({ ...base, selected: MAX_SAVED_CHARTS })).toBeNull();
    expect(submitBlocker({ ...base, selected: MAX_SAVED_CHARTS + 1 })).toBe('Pick 30 charts or fewer.');
    expect(submitBlocker({ ...base, title: 'x'.repeat(121), selected: 1 })).toBe('Keep the title to 120 characters or fewer.');
    expect(submitBlocker({ ...base, target: 'existing', selected: 1 })).toBe('Choose a report to add to.');
  });

  it('with no reports, "Add to an existing report" is disabled and says why', async () => {
    server({ reports: [] });
    await openDialog();
    const existing = within(dialog()).getByRole('radio', { name: 'Add to an existing report' });
    await waitFor(() => expect(existing).toBeDisabled());
    expect(existing).toHaveAccessibleDescription('You have no reports for this file yet.');
  });

  it('lists the reports of this workspace with their last-edited date', async () => {
    const api = server();
    await openDialog();
    await userEvent.click(within(dialog()).getByRole('radio', { name: 'Add to an existing report' }));
    expect(await within(dialog()).findByRole('radio', { name: /October review/ })).toBeEnabled();
    expect(within(dialog()).getByRole('radio', { name: 'October review' })).toHaveAccessibleDescription('Last edited 21 November 2026');
    expect(api.calls.map((c) => c.path)).toContain('/reports');
  });
});

describe('what is sent', () => {
  it('a new report: exactly filters, widget ids (dashboard order) and the title; nothing else', async () => {
    const api = server();
    await openDialog('/datasets/d1/dashboard?filters=' + encodeURIComponent(JSON.stringify({ 'cat:store': ['Durban', 'Sandton'] })));
    expect(within(dialog()).getByText('Filtered to: Store is Durban, Sandton.')).toBeInTheDocument();
    expect(within(dialog()).queryByText(/Unapplied changes/)).not.toBeInTheDocument();
    await userEvent.click(submit());
    await waitFor(() => expect(saves(api)).toHaveLength(1));
    const body = saves(api)[0]!.body as SaveDashboardToReportRequest;
    expect(saves(api)[0]!.method).toBe('POST');
    expect(saves(api)[0]!.path).toBe('/datasets/d1/dashboard/save-to-report');
    expect(body).toEqual({ filters: [{ filter_id: 'cat:store', values: ['Durban', 'Sandton'] }], widget_ids: ['w1', 'w2'], title: 'Card sales, dashboard' });
    expect(Object.keys(body).sort()).toEqual(['filters', 'title', 'widget_ids']);
  });

  it('an existing report: report_id and no title', async () => {
    const api = server({ save: () => ({ status: 200, body: report('r1', 'October review', { block_count: 5 }) }) });
    await openDialog();
    await chooseExisting('October review');
    await userEvent.click(submit());
    await waitFor(() => expect(saves(api)).toHaveLength(1));
    expect(saves(api)[0]!.body).toEqual({ filters: [], widget_ids: ['w1', 'w2'], report_id: 'r1' });
  });

  it('a change in the filters bar the charts have not been run with is not sent, and the note says so', async () => {
    const api = server();
    // From is later than To: the bar keeps it, but it is never sent (so the charts on screen have no date filter).
    await openDialog('/datasets/d1/dashboard?filters=' + encodeURIComponent(JSON.stringify({ date: ['2026-10-20', '2026-10-05'], 'cat:store': ['Durban'] })));
    expect(within(dialog()).getByText('Filtered to: Store is Durban.')).toBeInTheDocument();
    expect(within(dialog()).getByText('Unapplied changes in the filters bar are not included.')).toBeInTheDocument();
    await userEvent.click(submit());
    await waitFor(() => expect(saves(api)).toHaveLength(1));
    expect((saves(api)[0]!.body as SaveDashboardToReportRequest).filters).toEqual([{ filter_id: 'cat:store', values: ['Durban'] }]);
  });

  it('a double click (or Enter twice) sends one request', async () => {
    const api = server({ save: () => new Promise(() => {}) });
    await openDialog();
    const form = submit().closest('form')!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    await userEvent.dblClick(submit());
    expect(saves(api)).toHaveLength(1);
    expect(submit()).toHaveTextContent('Saving…');
    expect(submit()).toBeDisabled();
  });
});

describe('after saving', () => {
  it('201: the dialog closes and the toast says the report was created, with Open report', async () => {
    const api = server();
    const { router } = await openDialog();
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/reports')).toHaveLength(1));
    await userEvent.click(submit());
    const toast = await screen.findByText('Created report "Card sales, dashboard" and saved 2 charts to it.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(toast.closest('[data-toast]') as HTMLElement).getByRole('link', { name: 'Open report' })).toHaveAttribute('href', '/reports/rNew');
    // It does not navigate on its own.
    expect(router.state.location.pathname).toBe('/datasets/d1/dashboard');
    // The reports list was read again (it was on screen, so it refetched at once).
    expect(api.calls.filter((c) => c.path === '/reports')).toHaveLength(2);
  });

  it('200: the toast says the charts were saved to that report', async () => {
    server({ save: () => ({ status: 200, body: report('r1', 'October review', { block_count: 5 }) }) });
    const { client } = await openDialog();
    client.setQueryData(reportKeys.detail('r1'), { id: 'r1' });
    await chooseExisting('October review');
    await userEvent.click(submit());
    expect(await screen.findByText('Saved 2 charts to "October review".')).toBeInTheDocument();
    expect(client.getQueryState(reportKeys.detail('r1'))?.isInvalidated).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Saved 2 charts to "October review".')).not.toBeInTheDocument();
  });
});

const fieldError = (path: string, message = 'Refused.') => ({
  status: 422,
  body: { code: 'validation_failed', message: 'Some fields are not valid.', details: { fields: [{ location: 'body', path, message }] } },
});

describe('errors stay in the dialog and keep the choices', () => {
  it('422 report_id (open share link): says so, disables that report and reads the list again', async () => {
    const api = server({ save: () => fieldError('report_id') });
    await openDialog();
    await chooseExisting('October review');
    const listReads = api.calls.filter((c) => c.path === '/reports').length;
    await userEvent.click(submit());
    expect(
      await within(dialog()).findByText("That report has an open share link, so it can't be changed. Turn the link off, or save to a new report."),
    ).toBeInTheDocument();
    const r1 = within(dialog()).getByRole('radio', { name: /October review/ });
    expect(r1).toBeDisabled();
    expect(r1).toHaveAccessibleDescription('Last edited 21 November 2026 Has an open share link. Turn it off, or save to a new report.');
    expect(within(dialog()).getByRole('radio', { name: 'Add to an existing report' })).toBeChecked();
    expect(within(dialog()).getByText('2 of 3 charts')).toBeInTheDocument();
    await waitFor(() => expect(api.calls.filter((c) => c.path === '/reports').length).toBeGreaterThan(listReads));
  });

  it('422 on a widget: that chart is unticked and disabled, named, and the dashboard is read again', async () => {
    const api = server({ save: () => fieldError('widget_ids.1', 'This chart could not be run.') });
    await openDialog();
    const dashboardReads = api.calls.filter((c) => c.path.startsWith('/datasets/d1/dashboard') && !c.path.endsWith('save-to-report')).length;
    await userEvent.click(submit());
    expect(
      await within(dialog()).findByText('Nothing was saved. "Sales by store" could not be run now, so it was left out. Save again to save the others.'),
    ).toBeInTheDocument();
    const box = within(dialog()).getAllByRole('checkbox')[1]!;
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(within(dialog()).getByText('1 of 3 charts')).toBeInTheDocument();
    expect(within(dialog()).getByRole('textbox', { name: 'Report title' })).toHaveValue('Card sales, dashboard');
    await waitFor(() =>
      expect(api.calls.filter((c) => c.path.startsWith('/datasets/d1/dashboard') && !c.path.endsWith('save-to-report')).length).toBeGreaterThan(dashboardReads),
    );
  });

  it('422 widget_ids (too many answers): says the report cannot hold them, with the numbers', async () => {
    server({ save: () => fieldError('widget_ids') });
    await openDialog();
    await chooseExisting('Card fees');
    await userEvent.click(submit());
    expect(
      await within(dialog()).findByText("That report can't hold this many more charts. It has 29 of 30 answers, so it has room for 1 chart; you picked 2."),
    ).toBeInTheDocument();
  });

  it('402 plan limit: the plan-limit wording and a link to Settings', async () => {
    server({
      save: () => ({ status: 402, body: { code: 'plan_limit', message: 'Limit.', details: { limit_key: 'max_reports_per_month', limit: 3, used: 3, upgrade_to: 'starter' } } }),
    });
    await openDialog();
    await userEvent.click(submit());
    expect(await within(dialog()).findByText(/Your Free plan includes 3 reports a month\. You have used 3 this month\./)).toBeInTheDocument();
    expect(within(dialog()).getByRole('link', { name: 'See your plan in Settings' })).toHaveAttribute('href', '/settings');
  });

  it.each([
    [409, 'dashboard_not_ready', 'The dashboard is not ready yet. Wait for Analyst to finish planning it.', false],
    [410, 'dataset_expired', 'This file has expired, so its dashboard can no longer be shown.', false],
    [404, 'not_found', 'We could not find that. It may have been deleted.', false],
    [429, 'rate_limited', 'Too many saves. Wait a minute.', true],
  ] as const)('%i %s: the usual wording; Retry only where trying again can help', async (status, code, text, retry) => {
    const api = server({ save: () => ({ status, body: { code, message: code === 'rate_limited' ? text : 'x' } }) });
    await openDialog();
    await userEvent.click(submit());
    expect(await within(dialog()).findByText(text)).toBeInTheDocument();
    const retryButton = within(dialog()).queryByRole('button', { name: 'Retry' });
    expect(Boolean(retryButton)).toBe(retry);
    if (retryButton) {
      await userEvent.click(retryButton);
      await waitFor(() => expect(saves(api)).toHaveLength(2));
    }
  });

  it('a network failure: the connection message and Retry', async () => {
    let attempts = 0;
    const api = server({
      save: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return { status: 201, body: report('rNew', 'Card sales, dashboard') };
      },
    });
    await openDialog();
    await userEvent.click(submit());
    expect(await within(dialog()).findByText('We could not reach the server. Check your connection and try again.')).toBeInTheDocument();
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Created report/)).toBeInTheDocument();
    expect(saves(api)).toHaveLength(2);
  });
});
