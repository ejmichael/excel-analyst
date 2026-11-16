import { describe, expect, it } from 'vitest';
import { logPath } from '../../src/lib/logger.js';
import { blocksContainPersonalData, createShareLinkBody, isLive, newToken, toPublicReport } from '../../src/services/shareLinks.js';
import type { Block, ReportDetail } from '../../src/types/api.js';

describe('token', () => {
  it('is 43 base64url characters (32 random bytes) and never repeats', () => {
    const tokens = new Set(Array.from({ length: 1000 }, newToken));
    expect(tokens.size).toBe(1000);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('CreateShareLinkRequest', () => {
  it.each([[{}], [{ expires_in_days: 7 }], [{ expires_in_days: 30, show_working: true }], [{ expires_in_days: 90 }], [{ expires_in_days: null }]])('accepts %j', (body) => {
    expect(createShareLinkBody.safeParse(body).success).toBe(true);
  });
  it.each([[{ expires_in_days: 14 }], [{ expires_in_days: '7' }], [{ show_working: 'yes' }], [{ token: 'x' }]])('refuses %j', (body) => {
    expect(createShareLinkBody.safeParse(body).success).toBe(false);
  });
});

describe('isLive', () => {
  const now = Date.parse('2026-11-16T10:00:00Z');
  it('valid while not revoked and not expired', () => {
    expect(isLive({ revoked_at: null, expires_at: null }, now)).toBe(true);
    expect(isLive({ revoked_at: null, expires_at: '2026-11-16T10:00:01Z' }, now)).toBe(true);
    expect(isLive({ revoked_at: null, expires_at: '2026-11-16T10:00:00Z' }, now)).toBe(false);
    expect(isLive({ revoked_at: '2026-11-15T10:00:00Z', expires_at: null }, now)).toBe(false);
  });
});

describe('contains_personal_data', () => {
  const b = (columns: string[], rows: Array<Record<string, string | number | null>>, dataset_id: string | null = null) => ({
    columns: columns.map((name) => ({ name, format: 'text' as const })),
    rows,
    dataset_id,
  });
  const none = new Map();

  it.each([
    ['an email value', b(['contact', 'n'], [{ contact: 'thandi@example.com', n: 1 }])],
    ['an SA mobile value', b(['who', 'n'], [{ who: '082 555 1234', n: 1 }])],
    ['a valid SA ID number', b(['ref', 'n'], [{ ref: '8001015009087', n: 1 }])],
    ['a column named like a person', b(['customer_name', 'total'], [{ customer_name: 'A', total: 2 }])],
    ['a column named like an email', b(['email', 'orders'], [{ email: 'x', orders: 2 }])],
  ])('true for %s (dataset deleted: names and values only)', (_name, block) => {
    expect(blocksContainPersonalData([block], none)).toBe(true);
  });

  it('true when a result column is a dataset column marked is_pii, whatever its name', () => {
    const cols = new Map([['d1', [{ name: 'Who', sql_name: 'who', semantic: 'person_name' as const, is_pii: true }]]]);
    expect(blocksContainPersonalData([b(['who', 'total'], [{ who: 'X', total: 1 }], 'd1')], cols)).toBe(true);
    // The same block from a file where that column is not personal.
    const clean = new Map([['d1', [{ name: 'Who', sql_name: 'who', semantic: 'category' as const, is_pii: false }]]]);
    expect(blocksContainPersonalData([b(['who', 'total'], [{ who: 'X', total: 1 }], 'd1')], clean)).toBe(false);
  });

  it('false for a clean report (stores, amounts, dates, an invalid 13-digit number)', () => {
    const clean = [
      b(['store', 'net'], [{ store: 'Padstal', net: 1234.5 }]),
      b(['day', 'orders'], [{ day: '2026-10-01', orders: 7 }]),
      b(['reference', 'n'], [{ reference: '1234567890123', n: 1 }]),
      b(['product_name', 'units'], [{ product_name: 'Honey 500g', units: 40 }]),
    ];
    expect(blocksContainPersonalData(clean, none)).toBe(false);
  });
});

describe('the public report shape', () => {
  const block: Block = {
    id: 'blk',
    dataset_id: 'dataset-secret-id',
    question: 'Q',
    title: 'T',
    sql: 'SELECT 1',
    columns: [],
    rows: [],
    row_count: 0,
    truncated: false,
    chart: { type: 'table', x: null, y: [], series: null, orientation: 'vertical', stacked: false, value_format: {} },
    narrative: 'N',
    follow_ups: [],
    checks: [{ type: 'total_reconciles', ok: false, label: 'Total matches' }],
    status: 'flagged',
    source: 'user',
    has_source_rows: true,
    created_at: '2026-11-16T10:00:00+02:00',
  };
  const detail: ReportDetail = {
    id: 'rep',
    workspace_id: 'workspace-secret-id',
    title: 'R',
    subtitle: null,
    period_label: null,
    notes: null,
    template_id: 'template-secret-id',
    block_count: 1,
    created_at: '',
    updated_at: '',
    brand: { business_name: 'Biz', logo_url: 'https://x.supabase.co/storage/v1/object/sign/branding/owner-id/logo.png?token=j', color: '#123456' },
    watermark: true,
    blocks: [{ position: 0, heading_override: null, block }],
    comparison: null,
  };

  it('without show_working: no sql, no checks, no source rows, still flagged, no workspace, template or dataset id', () => {
    const p = toPublicReport(detail, false, null);
    const json = JSON.stringify(p);
    for (const secret of ['workspace-secret-id', 'template-secret-id', 'dataset-secret-id', 'owner-id', 'storage']) expect(json).not.toContain(secret);
    expect(p).not.toHaveProperty('workspace_id');
    expect(p).not.toHaveProperty('template_id');
    expect(p.blocks[0]!.block).not.toHaveProperty('dataset_id');
    expect(p.blocks[0]!.block).toMatchObject({ sql: '', checks: [], has_source_rows: false, status: 'flagged' });
    expect(p.brand.logo_url).toBeNull();
  });

  it('with show_working: sql and checks, but source rows stay off', () => {
    const p = toPublicReport(detail, true, null);
    expect(p.blocks[0]!.block).toMatchObject({ sql: 'SELECT 1', checks: block.checks, has_source_rows: false });
  });
});

describe('request logs', () => {
  it('never contain a share-link token', () => {
    expect(logPath('/api/v1/public/reports/AbCdEf0123456789AbCdEf0123456789AbCdEf01234?x=1')).toBe('/api/v1/public/reports/[token]');
    expect(logPath('/api/v1/reports/abc/share-links')).toBe('/api/v1/reports/abc/share-links');
  });
});
