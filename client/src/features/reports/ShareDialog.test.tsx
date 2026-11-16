import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureApiClient, type Transport } from '@/api/client';
import { buildMe, newMockUser } from '@/api/mocks/data';
import type { Plan, ShareLink } from '@/api/types';
import { SessionProvider } from '@/auth/SessionProvider';
import { signedIn } from '@/test/session';
import { LINK_EXPLAINER, PERSONAL_DATA_CAVEAT, PERSONAL_DATA_NOTICE, ShareDialog } from './ShareDialog';
import { linkStatus } from './shareQueries';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDE';
const DAY = 86_400_000;

const link = (over: Partial<ShareLink> = {}): ShareLink => ({
  id: 'l1',
  report_id: 'r1',
  token: TOKEN,
  url: `https://app.example/r/${TOKEN}`,
  show_working: false,
  expires_at: null,
  revoked_at: null,
  view_count: 3,
  created_at: '2026-11-16T10:00:00+02:00',
  contains_personal_data: false,
  ...over,
});

function setup({ links = [] as ShareLink[], plan = 'solo' as Plan, created = (body: unknown) => json(201, { data: link({ id: 'new', ...(body as object), token: 'new', url: 'https://app.example/r/new' }) }) } = {}) {
  const user = newMockUser('owner@example.co.za', 'x');
  user.plan = plan;
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let current = links;
  const transport: Transport = async (url, init) => {
    const method = init.method ?? 'GET';
    const path = new URL(url).pathname.replace('/api/v1', '');
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });
    if (path === '/me') return json(200, { data: buildMe(user) });
    if (path === '/reports/r1/share-links' && method === 'GET') return json(200, { data: current });
    if (path === '/reports/r1/share-links' && method === 'POST') return created(body);
    const revoke = /^\/share-links\/(.+)$/.exec(path);
    if (revoke && method === 'DELETE') {
      const off = { ...current.find((l) => l.id === revoke[1])!, revoked_at: '2026-11-16T12:00:00+02:00' };
      current = current.map((l) => (l.id === off.id ? off : l));
      return json(200, { data: off });
    }
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  configureApiClient({ transport, getAccessToken: async () => 't', refreshAccessToken: async () => null, onUnauthorized: () => {} });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider backend={signedIn}>
        <ShareDialog open report={{ id: 'r1', title: 'October review' }} onClose={onClose} />
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { calls, posts: () => calls.filter((c) => c.method === 'POST').map((c) => c.body) };
}

const dialog = () => screen.getByRole('dialog');

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('ShareDialog: creating a link', () => {
  it('says plainly what a link does', async () => {
    setup();
    expect(within(dialog()).getByText(LINK_EXPLAINER)).toBeInTheDocument();
    expect(await screen.findByText('No links yet.')).toBeInTheDocument();
  });

  it.each([
    ['7 days', 7],
    ['30 days', 30],
    ['90 days', 90],
    ['No expiry', null],
  ])('expiry "%s" is sent as %s; working is off unless ticked', async (label, days) => {
    const { posts } = setup();
    await userEvent.click(within(dialog()).getByRole('radio', { name: label }));
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Create a link' }));
    await screen.findByRole('textbox', { name: 'New link' });
    expect(posts()).toEqual([{ expires_in_days: days, show_working: false }]);
  });

  it('ticking "Show how each answer was calculated" sends show_working, and the new link is shown to copy', async () => {
    const { posts } = setup();
    const box = within(dialog()).getByRole('checkbox', { name: 'Show how each answer was calculated (the SQL and checks)' });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Create a link' }));
    expect(await screen.findByRole('textbox', { name: 'New link' })).toHaveValue('https://app.example/r/new');
    expect(posts()).toEqual([{ expires_in_days: 30, show_working: true }]);
  });

  it('402 share_links opens the upgrade dialog', async () => {
    setup({
      plan: 'free',
      created: () => json(402, { error: { code: 'plan_limit', message: 'x', details: { limit_key: 'share_links', limit: 0, used: 0, upgrade_to: 'solo' } } }),
    });
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Create a link' }));
    expect(await screen.findByText('Share links are not included in your Free plan.')).toBeInTheDocument();
    expect(screen.getByText('The Solo plan includes more.')).toBeInTheDocument();
  });
});

describe('ShareDialog: personal details', () => {
  it('warns before creating when a link says the report may contain personal details, and says it is best effort', async () => {
    setup({ links: [link({ contains_personal_data: true })] });
    expect(await within(dialog()).findByText(PERSONAL_DATA_NOTICE)).toBeInTheDocument();
    expect(within(dialog()).getByText(PERSONAL_DATA_CAVEAT)).toBeInTheDocument();
  });

  it('warns after creating when the new link says so', async () => {
    setup({ created: () => json(201, { data: link({ id: 'new', contains_personal_data: true }) }) });
    await screen.findByText('No links yet.');
    expect(screen.queryByText(PERSONAL_DATA_NOTICE)).not.toBeInTheDocument();
    await userEvent.click(within(dialog()).getByRole('button', { name: 'Create a link' }));
    expect(await screen.findByText(PERSONAL_DATA_NOTICE)).toBeInTheDocument();
  });

  it('shows no notice when contains_personal_data is false', async () => {
    setup({ links: [link()] });
    await screen.findByText('Active');
    expect(screen.queryByText(PERSONAL_DATA_NOTICE)).not.toBeInTheDocument();
  });
});

describe('ShareDialog: existing links', () => {
  it('lists created date, expiry, working, views and status in words', async () => {
    const future = new Date(Date.now() + 10 * DAY).toISOString();
    const past = new Date(Date.now() - DAY).toISOString();
    setup({
      links: [
        link({ id: 'a', expires_at: future, show_working: true }),
        link({ id: 'b', expires_at: past, view_count: 1 }),
        link({ id: 'c', revoked_at: '2026-11-15T10:00:00+02:00' }),
      ],
    });
    const items = await within(dialog()).findAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Active');
    expect(items[0]).toHaveTextContent('Created 16 November 2026');
    expect(items[0]).toHaveTextContent('Shows how answers were calculated');
    expect(items[0]).toHaveTextContent('Viewed 3 times');
    expect(items[1]).toHaveTextContent('Expired');
    expect(items[1]).toHaveTextContent('Answers only · Viewed 1 time');
    expect(items[2]).toHaveTextContent('Turned off');
    // Only a working link can be copied or turned off.
    expect(within(items[1]!).queryByRole('button', { name: 'Copy link' })).not.toBeInTheDocument();
    expect(within(items[2]!).queryByRole('button', { name: 'Turn off' })).not.toBeInTheDocument();
  });

  it('status words: active, expired and turned off', () => {
    const now = Date.parse('2026-11-16T12:00:00+02:00');
    expect(linkStatus({ revoked_at: null, expires_at: null }, now)).toBe('active');
    expect(linkStatus({ revoked_at: null, expires_at: '2026-11-17T00:00:00+02:00' }, now)).toBe('active');
    expect(linkStatus({ revoked_at: null, expires_at: '2026-11-16T11:00:00+02:00' }, now)).toBe('expired');
    expect(linkStatus({ revoked_at: '2026-11-16T09:00:00+02:00', expires_at: null }, now)).toBe('off');
  });

  it('turning off asks first, then sends DELETE and shows "Turned off"', async () => {
    const { calls } = setup({ links: [link()] });
    const item = (await within(dialog()).findAllByRole('listitem'))[0]!;
    await userEvent.click(within(item).getByRole('button', { name: 'Turn off' }));
    expect(item).toHaveTextContent('Turn off this link?');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(item).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(within(dialog()).getAllByRole('listitem')[0]).toHaveTextContent('Turned off'));
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe('/share-links/l1');
  });

  it('copies with the clipboard API and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup({ links: [link()] });
    const item = (await within(dialog()).findAllByRole('listitem'))[0]!;
    await userEvent.click(within(item).getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(`https://app.example/r/${TOKEN}`);
    expect(within(item).getByText('Link copied.')).toBeInTheDocument();
  });

  it('without the clipboard API, selects the link in its field for the user to copy', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    setup({ links: [link()] });
    const item = (await within(dialog()).findAllByRole('listitem'))[0]!;
    await userEvent.click(within(item).getByRole('button', { name: 'Copy link' }));
    const field = within(item).getByRole('textbox') as HTMLInputElement;
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('readonly');
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
    expect(within(item).getByText(/The link is selected/)).toBeInTheDocument();
  });

  it('never puts the token in the page title', async () => {
    setup({ links: [link()] });
    await screen.findByText('Active');
    expect(document.title).not.toContain(TOKEN);
  });
});
