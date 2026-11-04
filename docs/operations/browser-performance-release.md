# Public browser performance release

The owner approved this release on 2026-11-04. Source commit: `d8d6a5c`.

## Changes

- Hosting sends a public timeline preload hint only for `/`. The browser fetches the first page while it downloads JavaScript. The application uses that same response.
- Each page has an AbortController. Leaving the page cancels its unfinished HTTP reads and prevents stale navigation from moving focus.
- All date labels use one Intl.DateTimeFormat instance. The date text and UTC format remain unchanged.
- The document includes a small inline favicon. The browser no longer requests `/favicon.ico`, which previously returned the HTML fallback.

These changes add no services or paid capacity. API contracts, permission checks, and database reads remain unchanged. There is no stored response cache in the browser client. Each navigation reads current public records.

## Measurements

The local benchmark used 30 renders of the current 20-item public timeline in Node.js:

| Metric | Before | After |
| --- | --- | --- |
| Median HTML render time | 1.647 ms | 0.082 ms |
| 95th percentile render time | 21.674 ms | 0.418 ms |
| Rendered HTML size | 16,060 bytes | 16,060 bytes |

This benchmark measures HTML generation, not browser paint or total load time.

A production browser trace before the change recorded the HTML first byte at 220 ms, the script from 225 to 413 ms, and the timeline request from 415 to 693 ms.

A production reload after the change recorded the HTML first byte at 207 ms, the script from 215 to 482 ms, and the timeline request from 214 to 532 ms. The timeline request started 7 ms after the HTML first byte instead of 195 ms. There was one timeline request, initiated by the preload hint. There was no favicon request.

Network timings varied. The first post-release sample completed its timeline request at 941 ms, with a 636 ms request duration. These samples prove removal of the script-to-query dependency; they do not establish a fixed total-load percentage improvement.

Rapid navigation in both the local browser and production canceled the two abandoned profile fetches with `net::ERR_ABORTED`. The final timeline remained visible.

## Validation and release

`npm run check` passed: 494 tests passed, 69 skipped. The added checks cover request cancellation and the home-only preload hint. The production artifact test still verifies a deterministic build. `git diff --check` passed.

The home page and direct Agent route returned 200 and matched the local HTML. The preload hint was present only on `/`. `/v1` returned 200. CSP and `nosniff` remained present.

- Project: `gen-lang-client-0607406471`
- Site: `nobodyasked-pobrespandas-prod`
- Hosting version: `3e806a3be8bfed2e`
- Release: `1793770140056000`
- Release time: `2026-11-04T05:29:00.056Z`
- Previous version: `dfcf3a47f4818f27`
- HTML SHA-256: `d8222e8ad01bf07dcf5d0bb4d510d50087504cf240f0ae1bb427f8612acf0666`

Use the existing Hosting rollback procedure if a regression is found. No API revision, database, or permission changed.
