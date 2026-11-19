import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DatasetQuality, QualityBand, QualityIssue } from '@/api/types';
import { QualityTab } from './QualityTab';
import { column, dataset, fakeApi, renderAt } from './testing';

const ds = dataset({
  row_count: 25,
  columns: [
    column('Store', 'text', { display_name: 'Shop' }),
    column('Amount', 'decimal', { semantic: 'currency_zar' }),
    column('Email', 'text', { semantic: 'email', is_pii: true }),
  ],
});

function issue(extra: Partial<QualityIssue>): QualityIssue {
  return {
    id: `${extra.kind ?? 'inconsistent_case'}:${extra.column ?? '_'}`,
    kind: 'inconsistent_case',
    severity: 'medium',
    column: 'store',
    title: 'Store names are written in different ways',
    detail: 'They may be counted apart.',
    affected_rows: 9,
    examples: ['cafe rose', 'CAFE ROSE'],
    ...extra,
  };
}

function quality(extra: Partial<DatasetQuality> = {}): DatasetQuality {
  return {
    dataset_id: 'd1',
    score: 86,
    band: 'good',
    parts: [
      { key: 'missing', score: 100, note: 'none found' },
      { key: 'duplicates', score: 94, note: '1 extra copy of a row' },
      { key: 'types', score: 100, note: 'none found' },
      { key: 'odd_values', score: 70, note: '2 extreme values' },
      { key: 'consistency', score: 64, note: 'store written in two ways' },
    ],
    issues: [issue({})],
    rows_checked: 25,
    computed_at: '2026-11-19T09:00:00+02:00',
    ...extra,
  };
}

const rgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};

const open = (body: DatasetQuality) => {
  const requests = fakeApi(() => ({ body }));
  renderAt(<QualityTab dataset={ds} />, '/datasets/d1/quality');
  return requests;
};

describe('Quality tab: the score card', () => {
  it.each([
    ['very_clean', 'Very clean', '#1E7A5F'],
    ['good', 'Good, with a few things to tidy', '#1E7A5F'],
    ['needs_attention', 'Needs attention', '#B27A00'],
    ['needs_cleaning', 'Needs cleaning first', '#B4472B'],
  ] as const)('%s: says "%s" in words and draws the ring in %s', async (band: QualityBand, words, colour) => {
    open(quality({ band, score: 42 }));
    expect(await screen.findByRole('heading', { level: 2, name: words })).toBeInTheDocument();
    const ring = document.querySelector('[data-score-ring]') as HTMLElement;
    expect(ring.style.color).toBe(rgb(colour));
    // The server's score, as given.
    expect(within(ring).getByText('42')).toBeInTheDocument();
    expect(within(ring).getByText('out of 100')).toBeInTheDocument();
    expect(ring.querySelector('circle[stroke-dasharray="42 100"]')).not.toBeNull();
  });

  it('with issues: "N issues found." and that fixes come later; never claims totals are unaffected', async () => {
    open(quality({ issues: [issue({}), issue({ kind: 'missing_values', id: 'missing_values:store' })] }));
    expect(await screen.findByText('2 issues found.')).toBeInTheDocument();
    expect(screen.getByText('Fixes arrive in a later update.')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/change your totals/i);
  });

  it('a sampled file says how many rows were checked', async () => {
    open(quality({ rows_checked: 20 }));
    expect(await screen.findByText('We checked the first 20 rows of 25.')).toBeInTheDocument();
  });
});

describe('Quality tab: what the score is made of', () => {
  it('five rows with label, the server note and score, in the order the server sends them', async () => {
    const parts = [...quality().parts].reverse();
    open(quality({ parts }));
    const heading = await screen.findByRole('heading', { name: 'What the score is made of' });
    const rows = within(heading.closest('section')!).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-part'))).toEqual(['consistency', 'odd_values', 'types', 'duplicates', 'missing']);
    expect(rows.map((r) => r.querySelector('p')!.textContent)).toEqual([
      'Inconsistent writing',
      'Odd values',
      'Wrong types',
      'Duplicate rows',
      'Missing values',
    ]);
    expect(rows[0]).toHaveTextContent('store written in two ways');
    expect(rows[0]).toHaveTextContent('64 out of 100');
    expect((rows[0]!.querySelector('[style]') as HTMLElement).style.width).toBe('64%');
  });
});

describe('Quality tab: issues', () => {
  it('each issue: severity in words, title, detail, column name, rows affected and up to 3 examples in quotes', async () => {
    open(quality({ issues: [issue({ severity: 'high', examples: ['a', 'b', 'c', 'd'] })] }));
    const item = (await screen.findByRole('heading', { level: 3, name: 'Store names are written in different ways' })).closest('li')!;
    expect(within(item).getByText('High')).toBeInTheDocument();
    expect(item).toHaveTextContent('They may be counted apart.');
    expect(item).toHaveTextContent('Column: Shop · 9 of 25 rows');
    expect(item).toHaveTextContent('For example: “a”, “b”, “c”');
    expect(item).not.toHaveTextContent('“d”');
  });

  it.each(['high', 'medium', 'low'] as const)('severity %s has its word', async (severity) => {
    open(quality({ issues: [issue({ severity })] }));
    const words = { high: 'High', medium: 'Medium', low: 'Low' };
    expect(await screen.findByText(words[severity])).toBeInTheDocument();
  });

  it('a private column shows no examples (the server sends none)', async () => {
    open(quality({ issues: [issue({ kind: 'stray_whitespace', column: 'email', examples: [], title: 'Spaces around emails' })] }));
    const item = (await screen.findByRole('heading', { name: 'Spaces around emails' })).closest('li')!;
    expect(item).toHaveTextContent('Column: Email');
    expect(item).not.toHaveTextContent('For example');
    expect(within(item).queryByRole('link')).not.toBeInTheDocument();
  });

  it('"See the rows" opens the Data tab searching for the first example, only when that search can work', async () => {
    fakeApi(() => ({
      body: quality({
        issues: [
          issue({ title: 'Text column with examples' }),
          issue({ title: 'Number column', column: 'amount', kind: 'extreme_values', examples: ['99999'] }),
          issue({ title: 'Whole rows', column: null, kind: 'duplicate_rows', examples: [] }),
          issue({ title: 'No examples', kind: 'missing_values', examples: [] }),
        ],
      }),
    }));
    const router = renderAt(<QualityTab dataset={ds} />, '/datasets/d1/quality');
    const items = await screen.findAllByRole('listitem');
    const links = screen.getAllByRole('link', { name: /See the rows/ });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName('See the rows: Text column with examples');
    expect(links[0]).toHaveAttribute('href', '/datasets/d1/data?q=cafe%20rose');
    expect(items.length).toBeGreaterThan(4);
    await userEvent.click(links[0]!);
    expect(router.state.location.pathname).toBe('/datasets/d1/data');
    expect(router.state.location.search).toBe('?q=cafe%20rose');
  });

  it('no issues: a friendly empty state', async () => {
    open(quality({ score: 100, band: 'very_clean', issues: [] }));
    expect(await screen.findByText('No issues found.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No issues found' })).toBeInTheDocument();
    expect(screen.getByText('Every check passed. Your file is ready for questions.')).toBeInTheDocument();
    expect(screen.queryByText('Fixes arrive in a later update.')).not.toBeInTheDocument();
  });

  it('nothing on the tab edits the file: no buttons, no fix or clean controls', async () => {
    open(quality({ issues: [issue({}), issue({ kind: 'missing_values', id: 'm', severity: 'high' })] }));
    await screen.findByText('2 issues found.');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByText(/fix all|clean|repair/i)).not.toBeInTheDocument();
    for (const link of screen.queryAllByRole('link')) expect(link).toHaveAccessibleName(/^See the rows/);
  });
});

describe('Quality tab: loading and errors', () => {
  it('a calm "Checking your file" while the first check runs', async () => {
    fakeApi(() => new Promise(() => {}));
    renderAt(<QualityTab dataset={ds} />, '/datasets/d1/quality');
    expect(await screen.findByRole('status')).toHaveTextContent('Checking your file');
  });

  it.each([
    [409, 'dataset_not_ready', 'This file is still being read. Try again in a moment.'],
    [410, 'dataset_expired', 'This file has expired, so it can no longer be checked.'],
  ])('%i: says so in words, with Retry', async (status, code, words) => {
    let fail = true;
    const requests = fakeApi(() => (fail ? { status, body: { code, message: 'x' } } : { body: quality() }));
    renderAt(<QualityTab dataset={ds} />, '/datasets/d1/quality');
    expect(await screen.findByText(words)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Good, with a few things to tidy' })).toBeInTheDocument();
    expect(requests).toHaveLength(2);
  });
});
