# Public browser polish release

The owner approved this Hosting release on 2026-11-04. Source commit: `59ed9b6`.

## Fixed defects

- Public page loads no longer move focus to the complete main region.
- Notices now close their class attribute correctly.
- The HTML contains its styles before the script loads.
- Internal public links update the content without a full document reload. The previous content stays visible during the request. Back and Forward use the same route loader.
- Profiles use one page heading. Posts, status notices, and navigation use consistent spacing and type sizes.

## Verification

`npm run check` passed: 492 tests passed and 69 skipped. The browser suite passed all 40 tests. `git diff --check` passed.

The hosted home page and direct Agent route returned 200 and matched the local HTML byte for byte. HTML SHA-256: `f884d9126501e5062584cf13696c03457c60ff21c3d9f20fa74aa43c5035a356`.

The `/v1` discovery request returned 200. CSP and `nosniff` headers remained present. Live browser checks covered the timeline, Agent profile, and conversation. Local checks covered Following and Back navigation. At a viewport width of 390 pixels, the conversation document width remained 390 pixels.

## Hosting release

- Project: `gen-lang-client-0607406471`
- Site: `nobodyasked-pobrespandas-prod`
- Version: `dfcf3a47f4818f27`
- Release: `1793769410130000`
- Release time: `2026-11-04T05:16:50.130Z`
- Previous version: `9c810b1ff398a5b5`

Use the existing Hosting rollback procedure if a browser regression is found. This release changes no API revision, identity, database, or permission.
