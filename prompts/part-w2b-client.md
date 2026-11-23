# PART W2b (CLIENT): the file page fits on a screen, and the charts read clearly

You are the **client engineer** for Analyst OS. Parts 1 to 5c, W1 and W2 are done and committed. A second Claude Code chat works in `server/` at the same time; you never touch it.
Work **only** in `client/`, plus the Client column of the slices table in `docs/STATUS.md`. Do not edit `docs/API_CONTRACT.md`, `docs/api-types.ts`, `docs/LLM_PROMPTS.md` or `docs/CONTRACT_CHANGES.md`. Nothing here changes the contract.

## Why this part exists
The user tested the file workspace on a real file and found layout problems. These are all presentation: **no figure changes, nothing is computed in the client.** Keep every existing theme token and add no colours.
1. The page header is too tall. On a 1080p screen the tabs sit about 600px down, so the dashboard starts below the fold. The "Please check" box and the file notes sit above the tabs on every tab.
2. Each headline tile carries a full-width "Show the working" button, which makes the row of tiles heavy.
3. A vertical bar chart (websites and no website by niche) truncates its category labels ("Barb…", "Diet…", "Hair…") so you cannot read it.
4. The hover tooltip on a horizontal bar chart covers the category labels it is describing.
5. The donut legend puts two items on one line and one on the next, so it is hard to scan.

## Read first (only these, in this order)
1. `CLAUDE.md` and `docs/STATUS.md`
2. Your own code: the file workspace header and shell, the warnings box, the "How we read this file" bar, the Dashboard widgets (kpi tile, chart wrapper, the working disclosure), the chart components and tooltips
Then reply with 5 bullets of what you understood, one per problem above, and say what you will leave alone. Then start.

## Build exactly this

**1. A compact file header (all tabs).**
- Heading row: the file name, the Ready chip, and a **More** menu (Rename, Delete) on the right instead of two always-visible buttons. Menu is keyboard-operable, closes on Escape and returns focus.
- One muted line under it: "115 rows, 10 columns, Booking app.xlsx, 44,4 kB, uploaded 23 Nov 2026. File deleted on 21 February 2027." Keep every fact that is shown today, joined in one line (wrapping allowed on a phone).
- **"How we read this file"** stays one line with the **Change** button; keep its text, but clamp it to one line on desktop with the full text in a `title` and available through a "More" toggle.
- The **"Please check" box** (the file's warnings, for example "We left out 882 empty or total rows") becomes a compact one-line notice: a warning icon, "2 things to check", and a chevron that expands it in place to the full list and the "Check how we read your file" button. It is **collapsed by default**, except when the file failed to read or there are 5 or more warnings (then expanded). Remember the choice per file in `sessionStorage` (wrapped in try/catch; the page works without it).
- Target: at 1360 x 800 the tab row is fully visible without scrolling and the first dashboard tiles start within the first screen. At 390 px wide nothing scrolls sideways.
- Keep every existing action, text and test reachable; update tests rather than deleting them.

**2. Headline tiles.** On `kpi` widgets replace the full-width button with a small **Show the working** text button (or an icon button with that accessible name) in the tile's bottom corner, opening the same disclosure inline below the number (the tile grows only while open). Other widget types keep their disclosure at the bottom but with less padding.

**3. Category labels that can be read.** For dashboard widgets (not the Ask answer card) of type `bar` where `orientation` is vertical: if any category label is longer than 10 characters or there are more than 6 categories, draw the chart horizontally instead, with the full label visible (wrap to two lines up to 28 characters, then truncate with the full text in the tooltip and in "View as table"). Horizontal charts get enough left margin for their labels. This is a rendering choice only; the data, order and values are exactly what the server sent.

**4. Tooltips.** On every chart a tooltip must not sit on top of the axis labels or the bar it describes: offset it from the pointer and let it overflow the plot area, and never cut it off at the card edge. Keyboard focus on a bar or slice shows the same information (or "View as table" remains the accessible route; say which you did).

**5. Donut legend.** One legend entry per line below the donut: colour swatch, label, value (the server's value formatted by `value_format`). Entries wrap sensibly on a phone. The colour is never the only identifier (the label is always shown).

## Tests (required)
- Header: More menu (open, keyboard, Escape, focus return), the one-line summary contains every fact, the notice is collapsed by default and expands, expanded by default at 5 or more warnings and when the file failed, the choice is remembered per file and works when `sessionStorage` throws, Change and Check-how-we-read still work.
- Tiles: the small working button opens the disclosure, accessible name, keyboard.
- Charts: vertical to horizontal switch by label length and by category count, not applied to the Ask answer card, labels not truncated under 28 characters, full text in tooltip and table; tooltip and legend structure.
- Existing tests still pass. Run `npm run typecheck`, `npm test` and `npm run build`; fix everything.

## Verify in a real browser
With Playwright and a throwaway user, upload fixture 02 and screenshot the Dashboard at 1360 x 800 (viewport screenshot, not full page) and 390 x 844: the tabs and first tiles must be visible without scrolling at 1360 x 800. Also screenshot the notice expanded, a horizontal-switched chart with long labels (fixture 01 or 02 if one qualifies, otherwise a mock), a tooltip on a horizontal bar and the donut legend. Tell me the screenshot paths. Delete the throwaway user afterwards.

## Finish
1. Update the Client column in `docs/STATUS.md`.
2. Commit in stages (1: header, 2: tiles, 3: charts, tooltips and legend, tests and STATUS). If you are interrupted, I will say "continue from the last commit"; then run `git log` and `git status`, say what is done and what remains, and carry on.
3. Tell me: what you built; anything that differs from this prompt; the screenshot paths; and what I should test by hand (open a file with warnings, expand and collapse the notice, the tab row on a 1080p screen, the horizontal chart, the tooltip, the donut legend).

## Do not
Touch `server/` or `fixtures/`; edit the contract files; compute or change any figure; reorder widgets or change what a chart shows; add colours; change the Ask answer card, report pages or print layout; log or store row values; commit anything outside `client/` and your STATUS column.