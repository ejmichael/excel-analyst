// Generates SYNTHETIC test files in ../fixtures/ plus expected.json. Deterministic (seeded). No real people, businesses or accounts.
// The files imitate formatting quirks only (decimal comma, space thousands, dd/mm/yyyy, preamble and total lines, windows-1252).
// They do NOT copy the layout of any real bank, card machine, point-of-sale or accounting product.
// Usage: node scripts/make-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../fixtures/', import.meta.url));
mkdirSync(OUT, { recursive: true });

// ---------- helpers ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const int = (rnd, lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

// money is handled as integer cents everywhere, so sums are exact
const group3 = (s, sep) => s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
function fmtZA(cents) { // 1 234,50 (space thousands, decimal comma)
  const neg = cents < 0; const c = Math.abs(cents);
  const s = `${group3(String(Math.floor(c / 100)), ' ')},${pad(c % 100)}`;
  return neg ? `-${s}` : s;
}
function fmtUS(cents, thousands = false) { // 1234.50 or 1,234.50
  const neg = cents < 0; const c = Math.abs(cents);
  const whole = String(Math.floor(c / 100));
  const s = `${thousands ? group3(whole, ',') : whole}.${pad(c % 100)}`;
  return neg ? `-${s}` : s;
}
const cents2 = (c) => Math.round(c) / 100; // for expected.json (number of rand)
const csvField = (v, delim) => {
  const s = String(v);
  return s.includes(delim) || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (arr, delim) => arr.map((v) => csvField(v, delim)).join(delim);

function dateParts(rnd, year, month, dayMax) { return { y: year, m: month, d: int(rnd, 1, dayMax) }; }
const ddmmyyyy = ({ y, m, d }) => `${pad(d)}/${pad(m)}/${y}`;
const iso = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
const cmpDate = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);

const expected = { generated_by: 'scripts/make-fixtures.mjs', note: 'Synthetic data. Amounts in rand. Use these to assert parser and query results.', files: {} };

// ---------- 01: card-sales style (semicolon, windows-1252, dd/mm/yyyy, "1 234,50", preamble, total row) ----------
{
  const rnd = mulberry32(20261001);
  const stores = ['Café Rosé Sandton', 'Müller Bakkery Pretoria', 'Pietermaritzburg Padstal'];
  const cards = ['VISA', 'MASTERCARD', 'DEBIT'];
  const rows = [];
  for (let i = 0; i < 240; i++) {
    const date = dateParts(rnd, 2026, 10, 31);
    const refund = i % 40 === 17; // 6 refunds
    const gross = (refund ? -1 : 1) * int(rnd, 2500, 250000); // R25.00 to R2 500.00
    const fee = refund ? 0 : Math.round(gross * 0.0275);
    rows.push({
      date, time: `${pad(int(rnd, 7, 21))}:${pad(int(rnd, 0, 59))}`, terminal: `T0${int(rnd, 1, 3)}`,
      store: pick(rnd, stores), card: pick(rnd, cards), ref: `TX${int(rnd, 10000000, 99999999)}`,
      gross, fee, net: gross - fee,
    });
  }
  rows.sort((a, b) => cmpDate(a.date, b.date) || a.time.localeCompare(b.time));
  const D = ';';
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const out = [
    'Sales report (synthetic test data)',
    'Period: 01/10/2026 to 31/10/2026',
    'Generated: 01/11/2026 06:00',
    '',
    line(['Transaction Date', 'Time', 'Terminal', 'Store', 'Card Type', 'Reference', 'Gross Amount', 'Fee', 'Net Amount'], D),
    ...rows.map((r) => line([ddmmyyyy(r.date), r.time, r.terminal, r.store, r.card, r.ref, fmtZA(r.gross), fmtZA(r.fee), fmtZA(r.net)], D)),
    line(['Total', '', '', '', '', '', fmtZA(sum('gross')), fmtZA(sum('fee')), fmtZA(sum('net'))], D),
  ].join('\r\n') + '\r\n';
  writeFileSync(OUT + '01_card_sales_semicolon_win1252.csv', Buffer.from(out, 'latin1')); // all chars used are in Latin-1, identical to windows-1252
  const byStore = {};
  for (const r of rows) byStore[r.store] = (byStore[r.store] || 0) + r.net;
  const sorted = [...rows].sort((a, b) => cmpDate(a.date, b.date));
  expected.files['01_card_sales_semicolon_win1252.csv'] = {
    encoding: 'windows-1252', delimiter: ';', decimal_separator: ',', thousands_separator: ' ',
    date_order: 'dmy', date_format_example: 'dd/mm/yyyy',
    preamble_lines: 4, header_line_1based: 5, excluded_rows: 1, excluded_rows_note: 'the final "Total" line',
    data_rows: rows.length, columns: 9,
    column_names: ['Transaction Date', 'Time', 'Terminal', 'Store', 'Card Type', 'Reference', 'Gross Amount', 'Fee', 'Net Amount'],
    pii_columns: [], date_range: [iso(sorted[0].date), iso(sorted[sorted.length - 1].date)],
    sums: { gross_amount: cents2(sum('gross')), fee: cents2(sum('fee')), net_amount: cents2(sum('net')) },
    refund_rows: rows.filter((r) => r.gross < 0).length,
    net_by_store: Object.fromEntries(Object.entries(byStore).map(([k, v]) => [k, cents2(v)])),
    reconcile_example: 'SUM(net_amount) grouped by store must equal sums.net_amount',
    warnings_expected: ['none required; the first/second date parts include values above 12, so day-first is unambiguous'],
  };
}

// ---------- 02: webstore-style orders (UTF-8 BOM, CRLF, comma, decimal point, ISO datetime with offset, PII) ----------
{
  const rnd = mulberry32(20261002);
  const first = ['Thandi', 'Pieter', 'Naledi', 'Johan', 'Ayesha', 'Sipho', 'Lerato', 'Willem', 'Zanele', 'Riaan', 'Fatima', 'Kobus'];
  const last = ['Test', 'Sample', 'Demo', 'Voorbeeld', 'Fiktief', 'Proef'];
  const products = [
    ['Rooibos tea, 100 bags', 6500], ['Biltong 250g', 9500], ['Honey 500g', 12000], ['Ceramic mug', 8900],
    ['Cotton tote bag', 5500], ['Hot sauce 150ml', 4500], ['Notebook A5', 7500], ['Candle, soy', 14900],
  ];
  const provinces = ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga', 'North West', 'Northern Cape'];
  const statuses = ['paid', 'paid', 'paid', 'paid', 'paid', 'paid', 'paid', 'refunded', 'pending'];
  const rows = [];
  for (let i = 0; i < 180; i++) {
    const date = dateParts(rnd, 2026, 10, 31);
    const [pname, price] = pick(rnd, products);
    const qty = int(rnd, 1, 4);
    const discount = rnd() < 0.2 ? Math.round(price * qty * 0.1) : 0;
    const fn = pick(rnd, first); const ln = pick(rnd, last);
    rows.push({
      id: `#${1001 + i}`, date, hh: int(rnd, 6, 22), mm: int(rnd, 0, 59), ss: int(rnd, 0, 59),
      name: `${fn} ${ln}`, email: `${fn}.${ln}${i}@example.com`.toLowerCase(), phone: `082 555 ${pad(int(rnd, 0, 9999), 4)}`,
      product: pname, qty, unit: price, discount, total: price * qty - discount,
      status: pick(rnd, statuses), province: pick(rnd, provinces),
    });
  }
  rows.sort((a, b) => cmpDate(a.date, b.date) || (a.hh - b.hh) || (a.mm - b.mm));
  rows.forEach((r, i) => { r.id = `#${1001 + i}`; });
  const D = ',';
  const header = ['Order ID', 'Created at', 'Customer name', 'Customer email', 'Phone', 'Product', 'Quantity', 'Unit price', 'Discount', 'Total', 'Payment status', 'Province'];
  const out = '﻿' + [
    line(header, D),
    ...rows.map((r) => line([r.id, `${iso(r.date)} ${pad(r.hh)}:${pad(r.mm)}:${pad(r.ss)} +0200`, r.name, r.email, r.phone, r.product, r.qty, fmtUS(r.unit), fmtUS(r.discount), fmtUS(r.total), r.status, r.province], D)),
  ].join('\r\n') + '\r\n';
  writeFileSync(OUT + '02_webstore_orders_utf8bom.csv', out, 'utf8');
  const sumAll = rows.reduce((s, r) => s + r.total, 0);
  const paid = rows.filter((r) => r.status === 'paid');
  const byProv = {};
  for (const r of paid) byProv[r.province] = (byProv[r.province] || 0) + r.total;
  const byProd = {};
  for (const r of paid) byProd[r.product] = (byProd[r.product] || 0) + r.qty;
  const sorted = [...rows].sort((a, b) => cmpDate(a.date, b.date));
  expected.files['02_webstore_orders_utf8bom.csv'] = {
    encoding: 'utf-8 (with BOM)', line_endings: 'CRLF', delimiter: ',', decimal_separator: '.', thousands_separator: null,
    date_order: 'iso', date_format_example: 'yyyy-mm-dd hh:mm:ss +0200 (a timestamp with offset)',
    preamble_lines: 0, header_line_1based: 1, excluded_rows: 0, data_rows: rows.length, columns: header.length, column_names: header,
    pii_columns: ['Customer name', 'Customer email', 'Phone'], date_range: [iso(sorted[0].date), iso(sorted[sorted.length - 1].date)],
    sums: { total_all_statuses: cents2(sumAll), total_paid_only: cents2(paid.reduce((s, r) => s + r.total, 0)), discount: cents2(rows.reduce((s, r) => s + r.discount, 0)) },
    paid_rows: paid.length, rows_by_status: Object.fromEntries(['paid', 'refunded', 'pending'].map((s) => [s, rows.filter((r) => r.status === s).length])),
    paid_total_by_province: Object.fromEntries(Object.entries(byProv).map(([k, v]) => [k, cents2(v)])),
    paid_units_by_product: byProd,
    quoted_field_example: 'Product "Rooibos tea, 100 bags" contains a comma and is quoted',
    privacy_expectation: 'No value from the three PII columns may appear in any prompt sent to the model; use placeholders',
  };
}

// ---------- 03: bank-style statement (comma delimiter, quoted "1,234.56", preamble, running balance, total row) ----------
{
  const rnd = mulberry32(20261003);
  const credits = ['EFT CREDIT CLIENT A', 'EFT CREDIT CLIENT B', 'CARD SETTLEMENT', 'INTEREST RECEIVED'];
  const debits = ['POS PURCHASE FUEL', 'POS PURCHASE GROCER', 'DEBIT ORDER INSURANCE', 'DEBIT ORDER SOFTWARE', 'EFT PAYMENT SUPPLIER', 'MONTHLY ACCOUNT FEE', 'ATM WITHDRAWAL'];
  let balance = 4521050; // R45 210.50
  const rows = [];
  const days = Array.from({ length: 150 }, () => int(rnd, 1, 31)).sort((a, b) => a - b);
  for (const d of days) {
    const isCredit = rnd() < 0.3;
    const amt = isCredit ? int(rnd, 50000, 1500000) : -int(rnd, 2500, 900000);
    balance += amt;
    rows.push({ date: { y: 2026, m: 10, d }, desc: isCredit ? pick(rnd, credits) : pick(rnd, debits), amt, bal: balance });
  }
  const D = ',';
  const net = rows.reduce((s, r) => s + r.amt, 0);
  const out = [
    'Account statement (synthetic test data)',
    'Statement period 01/10/2026 - 31/10/2026',
    line(['Date', 'Description', 'Amount', 'Balance'], D),
    ...rows.map((r) => line([ddmmyyyy(r.date), r.desc, fmtUS(r.amt, true), fmtUS(r.bal, true)], D)),
    line(['Total', '', fmtUS(net, true), ''], D),
  ].join('\n') + '\n';
  writeFileSync(OUT + '03_bank_statement_comma_quoted.csv', out, 'utf8');
  const credit = rows.filter((r) => r.amt > 0);
  const debit = rows.filter((r) => r.amt < 0);
  expected.files['03_bank_statement_comma_quoted.csv'] = {
    encoding: 'utf-8', delimiter: ',', decimal_separator: '.', thousands_separator: ',', date_order: 'dmy', date_format_example: 'dd/mm/yyyy',
    preamble_lines: 2, header_line_1based: 3, excluded_rows: 1, excluded_rows_note: 'the final "Total" line', data_rows: rows.length, columns: 4,
    column_names: ['Date', 'Description', 'Amount', 'Balance'], pii_columns: [],
    date_range: [iso(rows[0].date), iso(rows[rows.length - 1].date)],
    sums: { amount_net: cents2(net), credits: cents2(credit.reduce((s, r) => s + r.amt, 0)), debits: cents2(debit.reduce((s, r) => s + r.amt, 0)) },
    credit_rows: credit.length, debit_rows: debit.length, final_balance: cents2(rows[rows.length - 1].bal),
    notes: 'Amounts over 999.99 are quoted because they contain a comma. Debits are negative numbers.',
  };
}

// ---------- 04: ambiguous dates (every day and month <= 12): parser must pick day-first AND warn ----------
{
  const rnd = mulberry32(20261004);
  const items = ['Printer paper', 'Toner', 'Courier', 'Tea and coffee', 'Cleaning'];
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push({ d: int(rnd, 1, 12), m: int(rnd, 1, 12), item: pick(rnd, items), amt: int(rnd, 1500, 95000) });
  }
  const D = ',';
  const out = [
    line(['Date', 'Item', 'Amount'], D),
    ...rows.map((r) => line([`${pad(r.d)}/${pad(r.m)}/2026`, r.item, fmtUS(r.amt)], D)),
  ].join('\n') + '\n';
  writeFileSync(OUT + '04_ambiguous_dates.csv', out, 'utf8');
  expected.files['04_ambiguous_dates.csv'] = {
    encoding: 'utf-8', delimiter: ',', decimal_separator: '.', date_order: 'dmy',
    preamble_lines: 0, header_line_1based: 1, excluded_rows: 0, data_rows: rows.length, columns: 3, column_names: ['Date', 'Item', 'Amount'], pii_columns: [],
    sums: { amount: cents2(rows.reduce((s, r) => s + r.amt, 0)) },
    warnings_expected: ['date order ambiguous: no value has a part above 12; day-first assumed (South African norm)'],
    notes: 'Reparse with date_order "mdy" must change the parsed dates (and the date range) but not the sum.',
  };
}

writeFileSync(OUT + 'expected.json', JSON.stringify(expected, null, 2) + '\n', 'utf8');
console.log('Wrote fixtures to', OUT);
