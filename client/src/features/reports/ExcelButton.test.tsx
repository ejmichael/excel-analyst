import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { configureApiClient, type Transport } from '@/api/client';
import { isoDateInSast } from '@/lib/format';
import { ExcelButton, downloadReportExcel } from './ExcelButton';

const saved: Array<{ name: string; size: number }> = [];
vi.mock('@/lib/download', async (original) => ({
  ...(await original<typeof import('@/lib/download')>()),
  saveBlob: (blob: Blob, name: string) => saved.push({ name, size: blob.size }),
}));

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const file = (headers: Record<string, string> = {}) => new Response(new Uint8Array([0x50, 0x4b, 3, 4]), { status: 200, headers: { 'Content-Type': XLSX, ...headers } });
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

let requests: Array<{ url: string; auth: string | null }> = [];
function useTransport(answer: () => Response | Promise<Response>) {
  requests = [];
  const transport: Transport = async (url, init) => {
    requests.push({ url, auth: new Headers(init.headers).get('Authorization') });
    return answer();
  };
  configureApiClient({ transport, getAccessToken: async () => 't', refreshAccessToken: async () => null, onUnauthorized: () => {} });
}

const report = { id: 'r1', title: 'October review' };

beforeEach(() => {
  saved.length = 0;
});

describe('Download Excel', () => {
  it('fetches the export with the token and saves it under the server’s file name', async () => {
    useTransport(() => file({ 'Content-Disposition': 'attachment; filename="october-review-2026-11-16.xlsx"' }));
    await downloadReportExcel(report);
    expect(requests[0]).toEqual({ url: expect.stringMatching(/\/reports\/r1\/export\.xlsx$/), auth: 'Bearer t' });
    expect(saved).toEqual([{ name: 'october-review-2026-11-16.xlsx', size: 4 }]);
  });

  it('falls back to <title>-<date>.xlsx when the header is missing', async () => {
    useTransport(() => file());
    await downloadReportExcel(report);
    expect(saved[0]?.name).toBe(`october-review-${isoDateInSast()}.xlsx`);
  });

  it('shows a busy state, then says it is done', async () => {
    let finish: (r: Response) => void = () => {};
    useTransport(() => new Promise<Response>((resolve) => (finish = resolve)));
    render(<ExcelButton report={report} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download Excel' }));
    expect(screen.getByRole('button', { name: 'Preparing the Excel file…' })).toBeDisabled();
    await act(async () => finish(file()));
    expect(await screen.findByText('The Excel file has been downloaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
  });

  it.each([
    [402, 'plan_limit', {}, 'Your plan does not include this download.'],
    [404, 'not_found', {}, 'We could not find this report. It may have been deleted.'],
    [409, 'conflict', {}, 'This report cannot be downloaded right now. Reload the page and try again.'],
    [429, 'rate_limited', { 'Retry-After': '12' }, 'Other downloads are being prepared. Wait 12 seconds and try again.'],
    [502, 'llm_failed', {}, 'The Excel file could not be prepared just now. Please try again.'],
    [500, 'internal', {}, 'This report is too large to export to Excel. Remove some answers or ask for fewer rows, then try again.'],
  ])('%s is said in words, and the button is never left busy', async (status, code, headers, message) => {
    useTransport(() =>
      json(
        status,
        { error: { code, message: status === 500 ? message : 'server text', ...(status === 402 ? { details: { limit_key: 'share_links', limit: 0, used: 0, upgrade_to: 'solo' } } : {}) } },
        headers,
      ),
    );
    render(<ExcelButton report={report} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download Excel' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
    expect(saved).toEqual([]);
  });

  it('a network failure is said in words too', async () => {
    useTransport(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<ExcelButton report={report} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download Excel' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not reach the server/i));
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
  });
});
