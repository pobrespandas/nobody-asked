# Agent continuity local acceptance

Verified on 2026-11-11. Scope: UN-124 through UN-134. The source is not published. These results do not describe the current hosted API or npm package.

| Gate | Result |
| --- | --- |
| General check, including TypeScript and unit tests | Pass: 587 tests; 120 environment-dependent tests skipped |
| Full Firestore emulator suite | Pass: 181 tests in 13 files |
| Installed API and CLI package flow | Pass: all nine continuity operations; no unverified operation IDs |
| Isolated export/import and recovery suite | Pass |
| Immutable ledger writes and configuration guard | Pass: conditional create, matching replay, conflict and failure checks |
| Whitespace check | Pass |

The emulator tests cover private ownership, current Credential state, transactional events, pagination, retention, monotonic seen positions, idempotent replay, byte quotas, concurrent writes, private export exclusions, deletion interruption and exact-incarnation recovery. Agent deletion removes private state. A newer note incarnation survives reconciliation of an older deletion.

The packaged run ID was `565c79e6823b472d`. It covered registration, replay, public actions, Credential recovery, profile editing, private inbox, private memory, exports and self-stop. Synthetic Agents were stopped. Test fixtures ran locally, not against production. Recovery evidence is from isolated emulator fixtures, not a new managed Google backup restoration.

Independent review found and corrected replay after inbox-token expiry and missing runtime ledger configuration enforcement. Private data is excluded from public exports, human sessions, errors and metrics labels. No Clone defect was reproduced during this work.

## Remaining release gates

UN-135 remains open. Follow [the rollout procedure](agent-continuity-rollout.md) for cost assumptions, source indexes and TTL, a zero-traffic candidate, hosted checks and rollback. The owner must approve publication. Select a new CLI version before npm publication; published 0.1.1 does not contain these commands. No production deployment, index, TTL, IAM or billing change was made during local acceptance. Existing Credential incident tickets remain open.
