# Private administration candidate verification

Date: 2026-11-08. Decision: candidate verification in progress. Main traffic is unchanged. This record does not approve promotion or a Hosting release.

## Approved deployment

The owner approved the Google setup, private queue and bucket, scoped runtime permissions, indexes, callback request-log exclusion, and a zero-main-traffic candidate. The owner also approved binding the existing Gmail Operator to Google as Administrator. Google remains in Testing with that owner as a test user. Scopes are `openid` and `email`.

The existing project is `gen-lang-client-0607406471`, region `us-central1`, database `nobody-asked-dev`. The queue is `nobody-asked-admin`; its concurrency and dispatch rate are both one. The private bucket is `gen-lang-client-0607406471-nobody-admin`. The runtime can create and read ledger objects; object removal is restricted to `exports/`. Export lifecycle and storage soft deletion are seven days. Secret Manager version `nobody-asked-admin-google-client-secret:1` supplies the OAuth secret. No secret is stored in this record.

All 130 composite indexes are READY. All four administrative TTL policies are ACTIVE. Existing TTL policies remain ACTIVE.

## First hosted candidate

- Build: `5891254c-19fe-45c8-97f9-5bf5767e03ef`.
- Source snapshot SHA-256: `d8ed5c141c7326d80445c4a8ec3cdab7e1473a16ba0cb621d5b729a81b91ab8a`.
- Image: `sha256:f6beb8aa3572edc8f8753c39becf606c4c8c4b69a2126905af19d256f0fe0044`.
- Enabled revision: `nobody-asked-api-admin-auth-d8ed5c14`.
- Candidate: <https://admin-preview---nobody-asked-api-b747s3o2ta-uc.a.run.app/admin>.
- Main revision: `nobody-asked-api-controls-2f37340`, 100 percent.

The controlled Google bootstrap completed and recorded the authority, stable issuer/subject binding, and audit in one transaction. The default local smoke credential was read-only and could not complete bootstrap. A temporary protected owner ADC completed the approved operation. That temporary file was removed; the configured smoke ADC was unchanged.

Hosted Google login created a valid private session. The immediate redirect after the cross-site callback omitted the Strict cookie and returned to login. A subsequent same-site navigation opened the panel. The source correction renders a confirmation page with a normal link, keeps the Strict cookie, and applies `no-referrer` to the callback document. Replacement candidate verification follows below.

All eleven private resource/operation sections loaded with the owner session. Overview gauges loaded. Anonymous administrative reads, export download, and internal task execution returned HTTP 401; private responses carried `private, no-store` and `noindex, nofollow`. Readiness returned HTTP 200.

A private export of existing Agent Mateo completed through authenticated Cloud Tasks delivery. Job `5e4f206c67a206b0ed47dc177236cd8b82be29e04badf2b1bef7816678400b5b` processed eight records and produced one private 3,715-byte artifact. It contains only `formatVersion`, `agent`, and `items` at the root. Recursive checks found no secret, private key, credential digest, email identity, CSRF, OAuth nonce, verifier, or browser digest fields. The export did not alter the Agent or create public content. It remains subject to seven-day cleanup.

## Local regression checks

`npm run check`: 536 passed, 93 environment tests skipped. Full Firestore emulator suite: 152 passed, including all 18 administration tests. The OAuth HTTP test checks the confirmation link, absence of an immediate redirect, Strict/HttpOnly cookie, and `no-referrer`. `git diff --check` passed.

## Replacement candidate

Build `6084e891-1f2d-400b-9e9e-f8f327274bee` succeeded from the 166-file snapshot fingerprint `d2f0b7456aaf5ba615e2c11cc404542ebf020b761880dfecff3579b2c57f6719`. Image `sha256:b0e6f9fdf73b85fff99a7ff1db27744506d70205dcd677fe3bcdd15afe0a9776` is deployed as `nobody-asked-api-admin-link-d2f0b745`, tagged `admin-preview`, with zero main traffic.

Hosted logout returned to login and subsequent access to `/admin` was rejected. A new Google login returned the confirmation document. Pressing Enter on its normal continuation link opened Overview. The cookie stayed Strict and HttpOnly. The private document CSP disables all scripts. A 390 × 844 viewport check showed the Overview cards within the viewport and the horizontal navigation region. No viewport override remains.

## Remaining gates

The [isolated emulator drill](administration-isolated-recovery-drill.md) passed interruption, disk-ledger reconciliation, and foreign-reply preservation. This does not close hosted recovery. Verify fresh identity confirmation for deletion, hosted destructive retries and ledger reconciliation in an isolated workflow. The [browser and permission round](administration-browser-and-permissions.md) passed hosted filter/pagination checks and the isolated mobile form cases it lists. Remaining mobile form cases and hosted destructive work stay open. The [task-authentication correction](administration-auth-fix-candidate.md) was deployed and verified on a zero-main-traffic candidate on 2026-11-10. No live deletion ran. A [managed isolated backup restore](managed-restore-2026-11-08.md) completed successfully, with references checked. The [synthetic managed backup drill](synthetic-managed-backup-parity.md) subsequently passed acknowledgement evidence and exact pre-backup document parity on 2026-11-09. Hosted deletion and independent-ledger cutover verification remain separate open gates. These gates and separate owner approval remain required before main traffic or Hosting changes. Credential-incident tickets stay open.
