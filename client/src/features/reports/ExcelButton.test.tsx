import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { configureApiClient, type ApiError, type Transport } from '@/api/client';
import { isoDateInSast } from '@/lib/format';
import { ExcelButton, TOO_LARGE_FALLBACK, describeExcelError, downloadReportExcel, isExportTooLarge } from './ExcelButton';

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
  ])('%s is said in words, and the button is never left busy', async (status, code, headers, message) => {
    useTransport(() =>
      json(
        status,
        { error: { code, message: 'server text', ...(status === 402 ? { details: { limit_key: 'share_links', limit: 0, used: 0, upgrade_to: 'solo' } } : {}) } },
        headers,
      ),
    );
    render(<ExcelButton report={report} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download Excel' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
    expect(saved).toEqual([]);
  });

  describe('a report too large to export (422 validation_failed, reason export_too_large)', () => {
    const TOO_LARGE = 'This report is too large to export to Excel. Remove some answers or ask for fewer rows, then try again.';
    const clickAndRead = async () => {
      render(<ExcelButton report={report} />);
      await userEvent.click(screen.getByRole('button', { name: 'Download Excel' }));
      const alert = await screen.findByRole('alert');
      expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
      expect(saved).toEqual([]);
      return alert;
    };

    it('the server’s exact body shows its message', async () => {
      // The body from server commit 5e1cdfd.
      const body = {
        error: {
          code: 'validation_failed',
          message: TOO_LARGE,
          details: { fields: [{ location: 'params', path: 'id', message: TOO_LARGE }], reason: 'export_too_large' },
        },
      };
      useTransport(() => json(422, body));
      const error = await downloadReportExcel(report).then(() => null, (e: unknown) => e as ApiError);
      expect(isExportTooLarge(error!)).toBe(true);
      expect(describeExcelError(error)).toBe(TOO_LARGE);
      expect(await clickAndRead()).toHaveTextContent(TOO_LARGE);
    });

    it('falls back to its own words if that 422 has no message', async () => {
      useTransport(() => json(422, { error: { code: 'validation_failed', message: '', details: { fields: [], reason: 'export_too_large' } } }));
      expect(await clickAndRead()).toHaveTextContent(TOO_LARGE_FALLBACK);
    });

    it.each([
      ['no reason', { fields: [{ location: 'params', path: 'id', message: 'Not valid.' }] }],
      ['an unknown reason', { fields: [], reason: 'something_else' }],
      ['no details', undefined],
      ['details that are not an object', 'oops'],
      ['null details', null],
    ])('another 422 (%s) is not "too large": the server’s message is shown as a written error', async (_name, details) => {
      useTransport(() => json(422, { error: { code: 'validation_failed', message: 'This report cannot be exported as it is.', ...(details === undefined ? {} : { details }) } }));
      const error = await downloadReportExcel(report).then(() => null, (e: unknown) => e as ApiError);
      expect(isExportTooLarge(error!)).toBe(false);
      expect(await clickAndRead()).toHaveTextContent('This report cannot be exported as it is.');
    });

    it('the old 500 with the same text is no longer special: the generic message', async () => {
      useTransport(() => json(500, { error: { code: 'internal', message: TOO_LARGE } }));
      const alert = await clickAndRead();
      expect(alert).not.toHaveTextContent(TOO_LARGE);
      expect(alert).toHaveTextContent('Something went wrong on our side. Please try again.');
    });
  });

  it('a network failure is said in words too', async () => {
    useTransport(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<ExcelButton report={report} />);
    await userEvent.click(screen.getByRole('button', { name: 'Download Excel' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not reach the server/i));
    expect(screen.getByRole('button', { name: 'Download Excel' })).toBeEnabled();
  });
});
