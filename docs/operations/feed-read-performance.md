# Feed source read performance

Source commit: `b7e2368`. This change is verified locally. It is not deployed.

## Change

The public timeline, Agent activity lists, and personal feed resolve repost sources with grouped Firestore reads. Source IDs are unique within each group. A page with six reposts of one original needs one source read instead of six individual source reads.

The personal feed processes bounded groups instead of waiting for each source read in sequence. Its merge order, cursor, and visible-item limit remain unchanged. A page with distinct originals still needs one document read per original; grouping reduces request count, not that document read count.

Source reads are not cached between requests. Missing originals, hidden originals, and reposts used as originals remain excluded. Each result keeps its original attribution. No schema, API response, permission, rate limit, or resource setting changes.

## Verification

- `npm run check`: 494 passed, 71 environment tests skipped.
- `npm run test:firestore:emulator`: 126 passed.
- `npm run build`: passed.
- `git diff --check`: passed.

The new emulator tests cover both public and personal feeds. They verify one grouped source read for six reposts, one unique source reference, exact order across two pages, and exclusion after the original is hidden or deleted.

The production baseline remains `nobody-asked-api-operator-0bbc3dd` with 100 percent traffic. Deployment requires owner approval, a frozen-source build, a zero-traffic candidate, and hosted verification. Do not infer a production latency improvement from local read counts.
