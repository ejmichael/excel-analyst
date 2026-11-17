import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { configurePublicTransport } from '@/api/publicReports';
import { BLOCK_TEMPLATES, blockFrom } from '@/api/mocks/blockFixtures';
import type { PublicBlock, PublicReport } from '@/api/types';
import { PublicReportPage, UNAVAILABLE_MESSAGE } from './PublicReportPage';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const EVIL = '<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 1">';
const NOT_FOUND = { error: { code: 'not_found', message: 'This link is not valid. Ask the sender for a new one.' } };

/** A public answer: no dataset id, and no SQL or checks unless the link shows the working. */
function publicBlock(key: string, working: boolean, over: Partial<PublicBlock> = {}): PublicBlock {
  const { dataset_id: _dataset, ...block } = blockFrom(BLOCK_TEMPLATES.find((t) => t.key === key)!, {
    question: `Question ${key}`,
    datasetId: 'd1',
    source: 'user',
    createdAt: '2026-11-02T10:00:00+02:00',
  });
  return { ...block, id: `b-${key}`, sql: working ? block.sql : '', checks: working ? block.checks : [], has_source_rows: false, ...over };
}

function makeReport({ working = false, logo = 'https://files.example/logo-1.png', ...over }: Partial<PublicReport> & { working?: boolean; logo?: string | null } = {}): PublicReport {
  return {
    id: 'r1',
    title: 'October review',
    subtitle: 'Three stores',
    period_label: 'October 2026',
    notes: null,
    block_count: 2,
    created_at: '2026-11-02T10:00:00+02:00',
    updated_at: '2026-11-02T10:00:00+02:00',
    brand: { business_name: 'Mokoena Bakery', logo_url: logo, color: '#7A1E3C' },
    watermark: true,
    blocks: [
      { position: 0, heading_override: null, block: publicBlock('by-store', working) },
      { position: 1, heading_override: 'Average sale', block: publicBlock('flagged', working) },
    ],
    comparison: null,
    ...over,
  };
}

let sent: RequestInit[] = [];
function useResponses(...responses: Array<() => Response | Promise<Response>>) {
  sent = [];
  let i = 0;
  configurePublicTransport(async (_url, init) => {
    sent.push(init);
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return next();
  });
}

function Leave() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/elsewhere')}>
      Leave
    </button>
  );
}

function renderAt(token = 'tok123') {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[`/r/${token}`]}>
        <Routes>
          <Route path="/r/:token" element={<><PublicReportPage /><Leave /></>} />
          <Route path="/elsewhere" element={<p>Elsewhere</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  document.title = 'Analyst';
  delete (window as { __pwned?: number }).__pwned;
});
afterEach(() => vi.restoreAllMocks());

describe('public report: what is sent and stored', () => {
  it('sends no Authorization header, no cookies, no referrer, and stores nothing', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookie = vi.spyOn(document, 'cookie', 'set');
    useResponses(() => json(200, { data: makeReport() }));
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'October review' });
    const headers = new Headers(sent[0]!.headers);
    expect(headers.has('Authorization')).toBe(false);
    expect(sent[0]).toMatchObject({ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(setItem).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  });

  it('sets robots and referrer meta tags and the report title on mount, and removes them on leaving', async () => {
    useResponses(() => json(200, { data: makeReport() }));
    renderAt('secret-token');
    await screen.findByRole('heading', { level: 1, name: 'October review' });
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
    expect(document.title).toBe('October review');
    expect(document.title).not.toContain('secret-token');
    await userEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Elsewhere')).toBeInTheDocument();
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
    expect(document.querySelector('meta[name="referrer"]')).toBeNull();
    expect(document.title).toBe('Analyst');
  });
});

describe('public report: the document look on screen', () => {
  it('is a sheet in the document look, with a bar above it holding only Download PDF', async () => {
    useResponses(() => json(200, { data: makeReport() }));
    renderAt();
    const heading = await screen.findByRole('heading', { level: 1, name: 'October review' });
    const sheet = heading.closest('[data-doc]');
    expect(sheet).not.toBeNull();
    expect(sheet!.querySelector('[data-report-root]')).not.toBeNull();
    const bar = screen.getByRole('button', { name: 'Download PDF' }).closest('[data-print="hide"]')!;
    expect(within(bar as HTMLElement).getAllByRole('button')).toHaveLength(1);
    expect(sheet!.contains(bar)).toBe(false);
  });

  it('the closing note has the watermark but not the owner’s Excel sentence; timestamps are marked to be left out', async () => {
    useResponses(() => json(200, { data: makeReport() }));
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'October review' });
    const note = document.querySelector('[data-closing-note]')!;
    expect(note).toHaveTextContent('Check important figures against your source file.');
    expect(note).toHaveTextContent('Made with Analyst');
    expect(note).not.toHaveTextContent('Excel');
    expect(document.querySelectorAll('[data-answer-time]')).toHaveLength(2);
  });

  it('without a watermark, the closing note has no "Made with" line', async () => {
    useResponses(() => json(200, { data: makeReport({ watermark: false }) }));
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'October review' });
    expect(screen.queryByText(/Made with/)).not.toBeInTheDocument();
  });

  it('a flagged answer shows its warning in place of the passed line', async () => {
    useResponses(() => json(200, { data: makeReport() }));
    renderAt();
    const [passed, flagged] = await screen.findAllByRole('article');
    expect(flagged!.querySelector('[data-flagged-note]')).toHaveTextContent('Check the numbers');
    expect(flagged!.querySelector('[data-check-line]')).toBeNull();
    expect(passed!.querySelector('[data-check-line]')).toHaveTextContent('All checks passed.');
  });
});

describe('public report: what is shown', () => {
  it('shows the brand header, the answers and the watermark, without any owner control', async () => {
    useResponses(() => json(200, { data: makeReport() }));
    renderAt();
    const header = await screen.findByTestId('report-header');
    expect(within(header).getByRole('heading', { level: 1, name: 'October review' })).toBeInTheDocument();
    expect(screen.getByTestId('report-brand-band')).toHaveStyle({ backgroundColor: 'rgb(122, 30, 60)' });
    expect(screen.getByRole('img', { name: 'Mokoena Bakery logo' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Average sale' })).toBeInTheDocument();
    expect(screen.getByText('Made with Analyst')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeEnabled();
    for (const name of [/Edit report/, /Delete/, /^Share$/, /Download Excel/, /This looks wrong/, /Add to report/, /Download CSV/]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('a flagged answer says "Check the numbers" even when its checks are hidden', async () => {
    useResponses(() => json(200, { data: makeReport({ working: false }) }));
    renderAt();
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Check the numbers');
    expect(note).toHaveTextContent('Some checks did not pass');
  });

  it('hides "How this was calculated" when the link does not show the working', async () => {
    useResponses(() => json(200, { data: makeReport({ working: false }) }));
    renderAt();
    await screen.findByRole('heading', { level: 1, name: 'October review' });
    expect(screen.queryByRole('button', { name: 'How this was calculated' })).not.toBeInTheDocument();
  });

  it('shows the SQL and checks when the payload has them, and never the source rows', async () => {
    const report = makeReport({ working: true });
    // Even if a payload said otherwise, a public page never offers source rows.
    report.blocks[0]!.block.has_source_rows = true;
    useResponses(() => json(200, { data: report }));
    renderAt();
    const toggles = await screen.findAllByRole('button', { name: 'How this was calculated' });
    await userEvent.click(toggles[0]!);
    expect(screen.getByText('The query')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Checks' })).toBeInTheDocument();
    expect(screen.queryByText(/rows behind this answer/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Show the rows/i })).not.toBeInTheDocument();
  });

  it('renders text from the API as inert text', async () => {
    const report = makeReport({ title: EVIL, notes: EVIL });
    report.blocks[0]!.heading_override = EVIL;
    report.blocks[1]!.block = { ...report.blocks[1]!.block, question: EVIL, narrative: EVIL };
    useResponses(() => json(200, { data: report }));
    const { container } = renderAt();
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(EVIL);
    expect(screen.getByRole('heading', { level: 2, name: EVIL })).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    expect(document.title).toBe(EVIL);
  });

  it('when the logo fails, fetches the report once more for a fresh URL, then hides it quietly', async () => {
    useResponses(
      () => json(200, { data: makeReport({ logo: 'https://files.example/logo-1.png' }) }),
      () => json(200, { data: makeReport({ logo: 'https://files.example/logo-2.png' }) }),
    );
    renderAt();
    fireEvent.error(await screen.findByRole('img', { name: 'Mokoena Bakery logo' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Mokoena Bakery logo' })).toHaveAttribute('src', 'https://files.example/logo-2.png'));
    expect(sent).toHaveLength(2);
    fireEvent.error(screen.getByRole('img', { name: 'Mokoena Bakery logo' }));
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Mokoena Bakery logo' })).not.toBeInTheDocument());
    expect(sent).toHaveLength(2);
    expect(screen.getByRole('heading', { level: 1, name: 'October review' })).toBeInTheDocument();
  });
});

describe('public report: unavailable links', () => {
  it('shows one identical page for every 404 (unknown, expired, turned off), never saying which', async () => {
    const pages: string[] = [];
    for (const token of ['unknown-token', 'expired-token', 'turned-off-token']) {
      useResponses(() => json(404, NOT_FOUND));
      const { container, unmount } = renderAt(token);
      expect(await screen.findByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument();
      expect(screen.queryByText(/revoked|turned off by/i)).not.toBeInTheDocument();
      pages.push(container.innerHTML);
      unmount();
    }
    expect(new Set(pages).size).toBe(1);
  });

  it('429 says how long to wait and offers Try again', async () => {
    useResponses(() => json(429, { error: { code: 'rate_limited', message: 'x' } }, { 'Retry-After': '20' }), () => json(200, { data: makeReport() }));
    renderAt();
    expect(await screen.findByText('This report is being opened a lot right now. Wait 20 seconds and try again.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'October review' })).toBeInTheDocument();
  });

  it('a network error offers Try again', async () => {
    useResponses(() => Promise.reject(new TypeError('Failed to fetch')), () => json(200, { data: makeReport() }));
    renderAt();
    expect(await screen.findByText('We could not load this report. Check your connection and try again.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'October review' })).toBeInTheDocument();
  });
});
