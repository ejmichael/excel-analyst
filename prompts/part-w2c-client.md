# PART W2c (CLIENT): full-width file pages, a cooler page colour, fresher charts

You are the **client engineer** for Analyst OS. Parts 1 to 5c, W1, W2 and W2b are done and committed. A second Claude Code chat works in `server/` at the same time (a small prompt change); you never touch it.
Work **only** in `client/`, plus the Client column of the slices table in `docs/STATUS.md`. Do not edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or `docs/CONTRACT_CHANGES.md`. Nothing here changes the contract. **No figure changes, nothing is computed in the client.**
A reference mock exists: `prompts/w2c-fresh-mock.html` (open it in a browser) with three frames and PNGs `prompts/w2c-now.png`, `prompts/w2c-fresh.png`, `prompts/w2c-cool.png`. **Build to match `w2c-cool.png`**, using the exact tokens below. The mock is a guide for look and spacing, not for layout counts (see item 1).

## Why this part exists
The user compared the app with a product called Quarry and wants (1) the file pages to use the full screen width instead of sitting in a narrow column with large side margins, (2) the page colour to be Quarry's cool near-white instead of our warm off-white, and (3) fresher, livelier charts. The app's green brand stays.

## Read first (only these, in this order)
1. `CLAUDE.md` and `docs/STATUS.md`
2. Your own code: the app shell (sidebar, top bar), the page container(s) and any `max-w-*` wrappers, the file workspace and each tab, the theme tokens (Tailwind config / CSS variables), the chart components and the series colour palette from Part 5c and its tests, and **which pages and components the report views and print layout share with the app** (owner report page, print, public report page)
Then reply with 7 bullets of what you understood. Include: where the page width is limited today, which pages become wide and which stay narrow, where the theme tokens live, which tokens you will change and which you will not touch, how you will make sure the report document look and the print output stay byte-for-byte the same, and what happens to the chart palette in reports. Then start.

## Build exactly this

**1. Full-width file pages.** Create (or extend) one page container with two variants and use it everywhere instead of ad-hoc `max-w` wrappers:
- `wide`: `max-width: 1800px`, centred, side padding 16px on phones, 24px from 640px, 32px from 1024px.
- `narrow`: today's width, unchanged.
Use `wide` for: the file workspace (header, notices and every tab) and the Datasets list. Keep `narrow` for: Settings, Templates, sign-in and sign-up, and **all report pages** (list, editor, owner view, print, public). Inside wide pages cap prose so lines stay readable: notices, the "How we read this file" line and the reading note at most 80 characters wide; the **Ask** and **Reports** tabs at most 1100px wide (left-aligned); the **Quality** tab at most 1200px; the **Data** tab and the **Dashboard** use the full width (the Data table fills it, first column sticky as now). Keep the Dashboard grid spans exactly as W2 built them (`quarter` 3 of 12, `half` 6, `full` 12 on desktop); the mock's three charts in a row is only illustrative. No horizontal page scroll at 390 px.

**2. Cooler page colour.** Change these **app shell** tokens only, in the one place they are defined:
- Page background `#F8FAFC` (was warm off-white `#F6F5F0`).
- Sidebar and top bar: white `#FFFFFF` with a 1px `#E2E8F0` border on their inner edge.
- Cards stay white with a `#E2E8F0` border (was `#D9D8CE`) and a very soft shadow `0 1px 2px rgba(15,23,42,0.04)`.
- Ink (main text) `#0F172A`; muted text `#475569`; hairlines and table rules `#E2E8F0`; table header/stripe tint `#F1F5F9`.
- Active sidebar item and chips: green tint `#E7F5EE`. The green accent `#1E7A5F` for buttons, tabs, links and the logo is **unchanged**; so are the status colours (green, amber `#B27A00`, red `#B4472B`) and focus rings.
- Form field borders: keep their current contrast against white (at least 3:1); only shift the hue to the cool scale if the contrast stays the same or better (for example `#7C8BA1`).
- Every text and control colour pair must still meet WCAG AA (4.5:1 text, 3:1 controls and chart marks). Add a test that checks the new token pairs.
- **Do not change** anything used by the report document look (Part 5b): the paper white, the report ink, hairlines and the public page desk colour, the print layout, the brand-colour logic or the contrast guard. If tokens are shared, pin the report values so report output is identical to before.

**3. Fresher chart colours (app charts only: Dashboard widgets and Ask answer cards).** Replace the series palette with this order, first colour used for every single-series chart:
`#0E9F6E` green, `#2563EB` blue, `#D97706` amber, `#7C3AED` violet, `#E11D48` rose, `#0891B2` cyan, `#65A30D` lime, `#475569` slate, `#EA580C` orange, `#C026D3` fuchsia.
Each colour must be at least 3:1 against white (add a test). The Part 5c rule that up to 10 series get clearly different colours stays: run the same distinctness check (colour distance of at least 25 between every pair in the first 10, as the 5c test does). If a pair fails, change only the failing colour minimally and tell me which. A single-series chart is one colour (green); other colours appear only when a chart splits into series. **Reports keep their current chart colours** (brand colour first, as built in 5b) unless the chart component can be re-coloured for the app without changing report or print output; if the component is shared, add a prop and leave the report call sites on the old palette.

**4. Chart styling (app charts only).**
- Bars: rounded outer ends (radius 4 to 5px; horizontal bars round the right end, vertical bars the top; stacked bars round only the outermost end of the stack; very short bars keep a minimum width so the rounding does not distort them).
- Gridlines dotted or dashed `#E2E8F0`; axis text 11 to 12px `#475569`; no axis lines.
- Line and area charts: 2.4px stroke with round joins, and a soft vertical gradient fill under the line from the series colour at 28% opacity to 0 (also for `area`). Give each gradient a unique id (several charts on one page must not share ids).
- Hover or focus on a bar, slice or point slightly emphasises it; the tooltip rules from W2b stay.
- Donut legend and "View as table" stay as built.

## Tests (required)
- Containers: the file workspace uses `wide`, report pages and Settings use `narrow`, the Ask and Reports tabs are capped at 1100px; no horizontal overflow at 390 px.
- Theme: the changed tokens exist in one place; contrast tests for the new token pairs and for the chart palette (3:1 on white); the palette distinctness test passes with the new colours.
- Reports unchanged: the existing report, print and public-page tests and snapshots pass **without being edited**; add one test that renders a report chart and asserts it still uses the previous series colours.
- Charts: rounded bar props, unique gradient ids for two area charts on one page, gradient present on line and area only.
- Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.

## Verify in a real browser
With Playwright and a throwaway user, upload fixture 02, and screenshot at 1920 x 1080 (viewport) the Dashboard, Data, Quality, Ask and Reports tabs, the Datasets list, and one **report owner view and its print preview** (these must look exactly as before). Also the Dashboard at 1360 x 800 and 390 x 844. Check: the file pages use the full width, the page background is `#F8FAFC` (read it from the page, do not eyeball it), the report views are unchanged, and the colours match `prompts/w2c-cool.png`. Tell me the screenshot paths. Delete the throwaway user afterwards.

## Finish
1. Update the Client column in `docs/STATUS.md`.
2. Commit in stages (1: containers and widths, 2: theme tokens, 3: chart palette and styling, 4: tests and STATUS). If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
3. Tell me: what you built; anything that differs from this prompt; whether any palette colour had to change; how reports were kept unchanged; the screenshot paths; and what I should test by hand (Dashboard on a wide screen, Data tab on a big file, the report view and a PDF print to confirm nothing changed, Settings still narrow).

## Do not
Touch `server/` or `fixtures/`; edit the contract files; compute or change any figure; change the report document look, print layout, public report page or the brand-colour logic; change the green accent, status colours or focus rings; add new fonts; reorder widgets or change what a chart shows; log or store row values; commit anything outside `client/` and your STATUS column.