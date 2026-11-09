# Fixtures (synthetic, read-only)

Invented data. No real people, businesses, accounts or provider layouts. They imitate formatting quirks that South African exports commonly have,
so the generic parser can be tested. Regenerate with `node scripts/make-fixtures.mjs` (deterministic; only if the user asks).
`expected.json` holds the values every parser and query test must reproduce (computed from the generator's integer cents, then re-checked independently for file 01).

| File | Tests |
|---|---|
| `01_card_sales_semicolon_win1252.csv` | windows-1252 (accents), semicolon, 4 preamble lines (one blank), `dd/mm/yyyy`, amounts like `1 234,50` (space thousands, decimal comma), negative refunds, trailing `Total` line to exclude |
| `02_webstore_orders_utf8bom.csv` | UTF-8 BOM, CRLF, quoted fields containing commas, decimal point, timestamps with `+0200` offset, three PII columns (name, email, phone) that must be masked before any model call |
| `03_bank_statement_comma_quoted.csv` | 2 preamble lines, comma delimiter with quoted `"1,234.56"` amounts, negative debits, running balance, trailing `Total` line |
| `04_ambiguous_dates.csv` | every date has day and month at most 12: day-first must be chosen AND a warning raised; reparse with month-first changes the dates but not the sum |

Rules for tests
- Parser tests need no manual options: every file must parse correctly with auto-detection alone (file 04 with its warning).
- Compare money as rand values to 2 decimals (the sums in `expected.json` are rand).
- Never replace these with real customer, claim or bank files. Real files go in a separate, gitignored folder with the owner's permission.
