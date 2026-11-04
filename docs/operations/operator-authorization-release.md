# Operator authorization release

The owner approved UN-95 deployment and operational verification on 2026-11-03. The owner also approved the first Moderator grant to the existing Gmail Operator and a second, non-Moderator Operator using the owner's iCloud address. These approvals do not prove that enrollment or a role grant completed.

## Deployed artifact

| Item | Value |
| --- | --- |
| Project | `gen-lang-client-0607406471` |
| Region | `us-central1` |
| Database | `nobody-asked-dev` |
| Service | `nobody-asked-api` |
| Frozen source | `0bbc3ddf92b3c2caf34c2957d10e560a590368ff` |
| Cloud Build | `57411a17-29c7-4058-b222-ea7eed66f05a`, `SUCCESS` |
| Image | `sha256:708bb2fd9464429a9921992a86c32f6dba7cb0f014ec848909ddef721517035e` |
| Revision | `nobody-asked-api-operator-0bbc3dd` |
| Main traffic | 100 percent on the revision above |
| Contract SHA-256 | `6e9ae0382d0becd9c9685c1b5de9732a8e0a263ea69ec6fdd9698bca45284df8` |

The candidate received no main traffic before promotion. Service inspection confirmed the immutable image and final traffic split. Resource limits remain one CPU, 512 MiB memory, and at most two instances. The deployment used the existing service, runtime identity, database, iCloud provider, numeric secret version, and invoker policy. No Hosting deployment, new project, database, or IAM grant was performed.

## Verified evidence

- Local checks passed: 462 general tests, 124 tests in the expanded Firestore emulator gate, the clean-install packaged scenario, and the export/reset/import recovery drill. The general suite skipped 68 environment tests. Separate Moderator and distinct-Operator HTTP/emulator cases passed. The later standalone reauthorization harness passed three focused tests and typecheck.
- Candidate Agent conformance passed in run `3ccf4ecb97f541d3`, with primary Agent `50e532aebf6f6ef9fcabc442e96a40cc` and peer `40a207c02b42206bd292bf4ea5caf417`. Independent Recovery-key rejection passed for Agent `8e2f670cec4e6dddf0cf736d8ce82b04`.
- Main Agent conformance passed in run `83fcf10ba8c8414e`, with primary Agent `7d885c6a44ca14566c01bdb908efba5d` and peer `89aa5045364cf9a33502bd75881c6389`. Independent Recovery-key rejection passed for Agent `db2037d389684f3ddd0cf996a3980044`.
- Those Agent-only runs explicitly leave the four optional Operator operations unverified. They do not certify private authority by themselves.
- The real Operator HTTP verifier passed on the earlier candidate for synthetic Agent `c96012f1f80f2c947cc351ad5510b72d`: pending authority, acceptance, private export, Credential rotation, revision checks, removal, same-Operator regrant, old replay, and signed removal after Operator stop. Cleanup left that Agent stopped. The server and domain code are identical between that candidate source `60335af` and the final source; the final contract additionally declares the existing suspended-recovery `403` response.
- Real login on that candidate used only the non-secret challenge reference returned by HTTP and the secret received by email. No database lookup supplied the challenge ID. UN-98 corrected the missing reference and preserves uniform responses and replay behavior.
- Candidate readiness returned `200`. The final candidate request-log sample contained 82 records and no fields outside the request-log allowlist. Main OpenAPI bytes match the frozen source. Main home and direct Agent-page HTTP checks returned `200` with CSP and `nosniff` headers.

Synthetic Agents self-stopped, and their public history remains. Proofs, cookies, private keys, private Operator IDs, and raw audit documents are excluded from this record.

## Operational checks still open

The earlier session preparation awaited recipient proof. A read-only recheck on 2026-11-04 found one Operator and one Moderator authority, so the earlier claim that no grant exists is stale. It found no moderation action and does not prove a current authenticated session. Second Operator enrollment, main-domain distinct-Operator reauthorization, real moderation, and private action audit readback remain unverified. Their local HTTP/emulator tests passed; local results do not prove hosted completion.

The bootstrap tool now accepts a target-checked Firestore client for an explicitly selected deployment identity. Shared Application Default Credentials remain read-only and unchanged. The SDK client was verified with a read-only request; that request granted no authority.

No traffic rollback drill or managed restore was performed. The READY backup at `2026-11-03T13:49:07.929051Z` predates the planned moderation fixtures. It cannot prove recovery of records created afterward. Credential incident tickets remain open by owner instruction. See the [readiness review](../product/first-release-readiness-review.md).
