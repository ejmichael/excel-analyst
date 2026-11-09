import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { DatasetDetail, DatasetStatus } from '@/api/types';
import { POLL_MS, SLOW_AFTER_MS, SLOW_POLL_MS, nextPollDelay, useDatasetPolling } from './queries';

const getDataset = vi.fn<(id: string) => Promise<DatasetDetail>>();
vi.mock('@/api/datasets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/datasets')>()),
  getDataset: (id: string) => getDataset(id),
}));

const detail = (status: DatasetStatus) => ({ id: 'd1', status }) as DatasetDetail;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('nextPollDelay', () => {
  it('polls every 1.5 s while profiling, and slows after 3 minutes', () => {
    expect(nextPollDelay('profiling', 0)).toBe(POLL_MS);
    expect(nextPollDelay('profiling', SLOW_AFTER_MS - 1)).toBe(POLL_MS);
    expect(nextPollDelay('profiling', SLOW_AFTER_MS)).toBe(SLOW_POLL_MS);
  });

  it('stops for every other status', () => {
    for (const status of ['ready', 'failed', 'expired', undefined] as const) {
      expect(nextPollDelay(status, 0)).toBe(false);
    }
  });
});

describe('useDatasetPolling', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    getDataset.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  // TanStack Query notifies observers through setTimeout(0), so give it one more tick after each step.
  const flush = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
      await vi.advanceTimersByTimeAsync(1);
    });

  it('stops polling once the dataset is ready', async () => {
    getDataset
      .mockResolvedValueOnce(detail('profiling'))
      .mockResolvedValueOnce(detail('profiling'))
      .mockResolvedValue(detail('ready'));
    const { result } = renderHook(() => useDatasetPolling('d1'), { wrapper });
    await flush(0);
    expect(getDataset).toHaveBeenCalledTimes(1);
    await flush(POLL_MS);
    await flush(POLL_MS);
    expect(result.current.data?.status).toBe('ready');
    const calls = getDataset.mock.calls.length;
    await flush(POLL_MS * 5);
    expect(getDataset).toHaveBeenCalledTimes(calls);
  });

  it('stops polling once the dataset failed', async () => {
    getDataset.mockResolvedValueOnce(detail('profiling')).mockResolvedValue(detail('failed'));
    const { result } = renderHook(() => useDatasetPolling('d1'), { wrapper });
    await flush(0);
    await flush(POLL_MS);
    expect(result.current.data?.status).toBe('failed');
    await flush(POLL_MS * 5);
    expect(getDataset).toHaveBeenCalledTimes(2);
  });

  it('stops polling when unmounted', async () => {
    getDataset.mockResolvedValue(detail('profiling'));
    const { unmount } = renderHook(() => useDatasetPolling('d1'), { wrapper });
    await flush(0);
    await flush(POLL_MS);
    expect(getDataset).toHaveBeenCalledTimes(2);
    unmount();
    await flush(POLL_MS * 10);
    expect(getDataset).toHaveBeenCalledTimes(2);
  });

  it('slows down and flags isSlow after 3 minutes', async () => {
    getDataset.mockResolvedValue(detail('profiling'));
    const { result } = renderHook(() => useDatasetPolling('d1'), { wrapper });
    await flush(0);
    expect(result.current.isSlow).toBe(false);
    await flush(SLOW_AFTER_MS + POLL_MS);
    expect(result.current.isSlow).toBe(true);
    const calls = getDataset.mock.calls.length;
    await flush(POLL_MS * 4); // 6 s: at the slow rate (10 s) at most one more call
    expect(getDataset.mock.calls.length - calls).toBeLessThanOrEqual(1);
    await flush(SLOW_POLL_MS);
    expect(getDataset.mock.calls.length).toBeGreaterThan(calls);
  });
});
