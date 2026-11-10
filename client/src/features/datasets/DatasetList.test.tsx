import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Dataset, DatasetStatus } from '@/api/types';
import { DatasetList } from './DatasetList';
import { StatusBadge } from './StatusBadge';

const dataset = (over: Partial<Dataset>): Dataset => ({
  id: 'd1',
  workspace_id: 'w1',
  name: 'Card sales October',
  original_filename: 'card_sales.csv',
  file_type: 'csv',
  size_bytes: 20_000,
  row_count: 1240,
  status: 'ready',
  error_message: null,
  error_details: null,
  warnings: [],
  expires_at: '2026-12-02T10:00:00+02:00',
  created_at: '2026-11-02T10:00:00+02:00',
  ...over,
});

const renderList = (props: Parameters<typeof DatasetList>[0]) =>
  render(
    <MemoryRouter>
      <DatasetList {...props} />
    </MemoryRouter>,
  );

describe('StatusBadge', () => {
  it.each<[DatasetStatus, string]>([
    ['profiling', 'Reading file'],
    ['ready', 'Ready'],
    ['failed', 'Could not read'],
    ['expired', 'Expired'],
  ])('%s says "%s" in words, with an icon', (status, text) => {
    const { container } = render(<StatusBadge status={status} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden');
  });
});

describe('DatasetList', () => {
  it('loading', () => {
    renderList({ status: 'pending', datasets: [] });
    expect(screen.getByRole('status')).toHaveTextContent('Loading your files');
  });

  it('error, with a retry', async () => {
    const onRetry = vi.fn();
    renderList({ status: 'error', datasets: [], error: 'We could not reach the server.', onRetry });
    expect(screen.getByRole('alert')).toHaveTextContent('We could not reach the server.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('empty: an upload prompt in words', () => {
    renderList({ status: 'success', datasets: [] });
    expect(screen.getByText('No files in this workspace yet')).toBeInTheDocument();
    expect(screen.getByText(/Upload a CSV or Excel export/)).toBeInTheDocument();
  });

  it('populated: name, file, status, rows, dates and expiry; link to the dataset', () => {
    renderList({
      status: 'success',
      datasets: [dataset({}), dataset({ id: 'd2', name: 'Old', original_filename: 'august.csv', status: 'expired', row_count: 2, created_at: '2026-09-01T10:00:00+02:00', expires_at: '2026-10-01T10:00:00+02:00' })],
      hasMore: true,
      onLoadMore: vi.fn(),
    });
    expect(screen.getByRole('link', { name: /Card sales October/ })).toHaveAttribute('href', '/datasets/d1');
    expect(screen.getByText('card_sales.csv')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText(/Uploaded 2 November 2026/)).toBeInTheDocument();
    expect(screen.getByText('We delete the file on 2 December 2026.')).toBeInTheDocument();
    expect(screen.getByText('The file was deleted on 1 October 2026.')).toBeInTheDocument();
    const rows = `${new Intl.NumberFormat('en-ZA').format(1240)} rows`;
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && Boolean(el.textContent?.startsWith(rows)))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });
});
