import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { configureApiClient, type UploadRequest } from '@/api/client';
import { buildMe, newMockUser } from '@/api/mocks/data';
import type { Me, Plan } from '@/api/types';
import { SessionProvider } from '@/auth/SessionProvider';
import { signedIn } from '@/test/session';
import { BrandSettingsPage, NO_BRANDING } from './BrandSettingsPage';
import { checkLogoFile } from './logoValidation';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const fileOf = (name: string, bytes: number, type = '') => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
};

function setup(plan: Plan, upload?: (req: UploadRequest) => Promise<Response>) {
  const user = newMockUser('owner@example.co.za', 'x');
  user.plan = plan;
  let me: Me = buildMe(user);
  const patches: unknown[] = [];
  configureApiClient({
    getAccessToken: async () => 't',
    refreshAccessToken: async () => null,
    onUnauthorized: () => {},
    transport: async (url, init) => {
      const path = new URL(url).pathname.replace('/api/v1', '');
      if (path === '/me' && (init.method ?? 'GET') === 'GET') return json(200, { data: me });
      if (path === '/me' && init.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { brand_color?: string; business_name?: string | null };
        patches.push(body);
        if (body.brand_color && plan === 'free') {
          return json(402, { error: { code: 'plan_limit', message: 'x', details: { limit_key: 'branding', limit: 0, used: 0, upgrade_to: 'solo' } } });
        }
        me = { ...me, brand: { ...me.brand, color: body.brand_color ?? me.brand.color } };
        return json(200, { data: me });
      }
      return json(404, { error: { code: 'not_found', message: 'x' } });
    },
    uploadTransport: async (_url, req) => (upload ? upload(req) : json(500, { error: { code: 'internal', message: 'x' } })),
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider backend={signedIn}>
        <MemoryRouter>
          <BrandSettingsPage />
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return { patches };
}

describe('checkLogoFile', () => {
  it('accepts PNG, JPEG and WebP up to 1 MB', () => {
    for (const name of ['logo.png', 'logo.JPG', 'logo.jpeg', 'logo.webp']) expect(checkLogoFile(fileOf(name, 2000))).toBeNull();
    expect(checkLogoFile(fileOf('logo.png', 1024 * 1024))).toBeNull();
  });

  it('refuses SVG and GIF with the reason, and other types', () => {
    expect(checkLogoFile(fileOf('logo.svg', 200))).toBe('SVG and GIF logos are not accepted. Use a PNG, JPEG or WebP image.');
    expect(checkLogoFile(fileOf('logo.gif', 200))).toMatch(/SVG and GIF/);
    expect(checkLogoFile(fileOf('logo.png', 200, 'image/svg+xml'))).toMatch(/SVG and GIF/);
    expect(checkLogoFile(fileOf('logo.bmp', 200))).toMatch(/not a PNG, JPEG or WebP/);
  });

  it('refuses a file over 1 MB, giving its size', () => {
    expect(checkLogoFile(fileOf('logo.png', 1024 * 1024 + 1))).toBe('The logo must be 1 MB or smaller. This file is 1,01 MB.');
  });
});

describe('BrandSettingsPage on the free plan', () => {
  it('disables colour and logo, explains why, and offers the upgrade dialog; the business name still works', async () => {
    const { patches } = setup('free');
    expect(await screen.findByText(`${NO_BRANDING} You can still set your business name.`)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Colour code' })).toBeDisabled();
    expect(screen.getByLabelText('Pick a colour')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload a logo' })).toBeDisabled();
    expect(screen.getByText(/Paid plans remove it/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(within(screen.getByRole('dialog')).getByText('Your own logo and brand colour are not included in your Free plan.')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Close' })[0]!);

    await userEvent.type(screen.getByRole('textbox', { name: 'Business name' }), 'Mokoena Bakery');
    await userEvent.click(screen.getByRole('button', { name: 'Save business name' }));
    await waitFor(() => expect(patches).toEqual([{ business_name: 'Mokoena Bakery' }]));
  });
});

describe('BrandSettingsPage on a paid plan', () => {
  it('validates the hex code and gives contrast guidance in words; the preview is the report header', async () => {
    const { patches } = setup('solo');
    const hex = await screen.findByRole('textbox', { name: 'Colour code' });
    await userEvent.clear(hex);
    await userEvent.type(hex, '#12345');
    expect(screen.getByText('Enter a colour as # and six letters or digits, for example #1E7A5F.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save colour' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Save colour' }));
    expect(patches).toEqual([]);

    await userEvent.clear(hex);
    await userEvent.type(hex, '#FFFF00');
    expect(screen.getByText(/^Dark text is used on this colour/)).toBeInTheDocument();
    // The preview uses the same ReportHeader as the report page, with the colour being edited.
    expect(screen.getByTestId('report-brand-band')).toHaveStyle({ backgroundColor: 'rgb(255, 255, 0)', color: 'rgb(0, 0, 0)' });
    await userEvent.click(screen.getByRole('button', { name: 'Save colour' }));
    await waitFor(() => expect(patches).toEqual([{ brand_color: '#FFFF00' }]));
  });

  it('uploads a logo with progress and can cancel', async () => {
    let finish: () => void = () => {};
    setup('solo', (req) => {
      req.onProgress(0.4);
      return new Promise<Response>((resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
        finish = () => resolve(json(200, { data: { business_name: null, logo_url: 'data:image/png;base64,AA==', color: '#1E7A5F' } }));
      });
    });
    // The file input is re-created when the buttons come back, so it is looked up each time.
    const fileInput = async () =>
      (await screen.findByRole('button', { name: 'Upload a logo' })).parentElement!.querySelector('input[type=file]') as HTMLInputElement;
    await userEvent.upload(await fileInput(), fileOf('logo.png', 5000, 'image/png'));
    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel upload' }));
    expect(await screen.findByText('Upload cancelled. Your previous logo is unchanged.')).toBeInTheDocument();

    await userEvent.upload(await fileInput(), fileOf('logo.png', 5000, 'image/png'));
    await screen.findByRole('progressbar');
    await act(async () => finish());
    expect(await screen.findByText('Your logo is saved.')).toBeInTheDocument();
  });

  it.each([
    [415, 'file_unsupported', 'This file is not a PNG, JPEG or WebP image.'],
    [413, 'file_too_large', 'The logo is larger than 1 MB.'],
    [422, 'validation_failed', 'The logo must be between 16 and 4,000 pixels wide and high.'],
  ])('shows the server message for %s in words', async (status, code, message) => {
    setup('solo', async () => json(status, { error: { code, message } }));
    const input = (await screen.findByRole('button', { name: 'Upload a logo' })).parentElement!.querySelector('input[type=file]') as HTMLInputElement;
    await userEvent.upload(input, fileOf('logo.png', 5000, 'image/png'));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
});
