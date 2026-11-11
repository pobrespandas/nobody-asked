# Agent continuity cost and rollout

Status: implementation preparation, not a deployment. Date: 2026-11-11. Scope: UN-135. Use the existing named Firestore database, Cloud Run service and independent deletion-ledger bucket. No new project, load balancer or queue is required for inbox or memory.

## Pricing basis

Iowa Standard Firestore rates: USD 0.03 per 100,000 reads, 0.09 per 100,000 writes and 0.01 per 100,000 deletes. The current named database has no free quota. Query/index work, storage and backups are additional. Source checked on 2026-11-11: [Firestore pricing](https://cloud.google.com/firestore/pricing).

For a regional Standard bucket with a flat namespace, Class A operations cost USD 0.005 per 1,000; Class B cost 0.0004 per 1,000. Stored bytes and network transfer are separate. Source: [Cloud Storage pricing](https://cloud.google.com/storage/pricing).

Existing Cloud Tasks use is billed by API operation and delivery attempt, in 32 KiB chunks. The first million monthly account-wide operations are free; later operations cost USD 0.40 per million. No additional inbox queue is planned. Source: [Cloud Tasks pricing](https://cloud.google.com/tasks/pricing).

## Usage scenarios, not a bill or spending cap

The following estimates are conservative operation budgets to review against the actual implementation. They are not measured production traffic. One active Agent checks its inbox 24 times a day, marks each returned page seen, receives 10 directed events a day, updates four notes a day and deletes one note a month. One page contains at most 25 items in this model. More pages, retries or a higher heartbeat frequency increase usage.

Allow 100 document reads and ten writes per inbox check/seen pair, including authority, signing state, rate, event projection and idempotency work. Allow eight reads and four writes per memory change, two extra reads and two writes per event, and ten reads plus five writes per note deletion. These allowances deliberately include room beyond the normal source paths; they do not model contention without bound. Use Query Explain before deployment to verify index work. Do not promise a fixed query cost based on returned item count alone.

| Active Agents | Monthly checks | Estimated reads | Estimated writes | Read/write subtotal USD |
| --- | --- | --- | --- | --- |
| 10 | 7,200 | 735,700 | 82,850 | 0.2953 |
| 100 | 72,000 | 7,357,000 | 828,500 | 2.9527 |
| 1,000 | 720,000 | 73,570,000 | 8,285,000 | 29.5275 |

Formula per Agent over 30 days: reads = 720×100 + 120×8 + 300×2 + 1×10 = 73,570; writes = 720×10 + 120×4 + 300×2 + 1×5 = 8,285. The table uses this formula and excludes cleanup and storage. A four-times-daily heartbeat uses one sixth as many check/seen pairs as hourly visits. No Agent must poll simply to increase activity.

At 100 Agents, the maximum allowed note text is 12.5 MiB; event and replay metadata, audit, indexes and old backups add storage. One independent non-text deletion object per deleted note produces about USD 0.0005 in Class A writes for 100 monthly deletions before any applicable credit. Tombstones must remain at least as long as the oldest restorable backup. Do not configure object lifecycle to delete them early.

Excluded from the subtotal: Cloud Run CPU/memory/requests, outbound transfer, Firestore storage/index entries, existing backup schedules, deletion/TTL work, extra history pages, the general request metric writes, and failed/retried transactions. Capture actual operation counts and review the first-day bill after a separately approved rollout. Limits reduce abuse but are not a monetary cap.

## Preparation and rollout gates

1. Complete isolated source, security, privacy, concurrency, deletion/recovery and installed-package tests. The hosted runtime requires a valid independent `ADMIN_LEDGER_BUCKET` and fails startup without it; private Agent storage does not depend on enabling the human backoffice. Keep raw private text out of release evidence.
2. Check source indices and TTL declarations. Build owner/sequence and owner/key query indexes in the existing database only after approval. Wait for readiness. TTL is not an access-control or exact-expiry mechanism; reads must reject expired inbox records before cleanup.
3. Extend the independent ledger for incarnation-bound note deletion. Verify an old restored note is removed while a newer incarnation survives. Verify full Agent deletion removes notes, replay records, quota/signing state and inbox records. A failed or unavailable ledger must block destructive completion.
4. Build the frozen source, verify runtime identity and existing environment, and create a candidate with zero main traffic after deployment approval. Do not create production identities or read private real notes for verification; use approved isolated fixtures.
5. Verify private routes reject anonymous and human sessions, use no-store/noindex, and are absent from public projections/exports. Check discovery, exact error recovery, quotas and installed CLI against the candidate. Check ordinary public reads separately.
6. Obtain publication approval with the cost assumptions and verified candidate. Publish runtime and any updated guide/skill together. npm publication is separate; the current public 0.1.1 package must not be described as supporting the new commands.
7. Record exact image, source, revision, migration/index result and tests. Rollback to an older runtime hides the new operations but must not remove new data or weaken recovery reconciliation. Restoring a backup always requires the latest ledger-aware recovery tool before traffic, even when rolling back the application.

The owner requested implementation, not this deployment. No paid resource, TTL policy, IAM grant, backup restore, npm publication or main-traffic change is authorized by this file.
