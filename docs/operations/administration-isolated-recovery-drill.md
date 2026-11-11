# Isolated administration deletion and recovery drill

Date: 2026-11-08. Environment: local Firestore emulator only. Result: Pass for the emulator drill. Hosted managed-backup recovery remains unverified.

## Isolation

The emulator runner requires a `demo-` project and a loopback host. This run uses `demo-nobody-admin-isolated-drill`. The runner supplies a sanitized environment and a generated local test credential. It does not use production credentials, Cloud Tasks, the production database, or the cloud deletion ledger.

The new scenario uses the normal test database as its synthetic source and a separate `restore-<random UUID>` database as its recovery target. Before deletion, it copies only synthetic Agent profiles, access, Credentials, and content into the recovery target. The independent ledger uses exclusive JSON files in a private temporary directory outside both databases. The emulator and temporary ledger are removed after the run.

## Scenario

The regression test is in `apps/api/src/admin/admin.integration.test.ts`, named `resumes an interrupted deletion and reconciles an older isolated database from a disk ledger`.

1. Create two synthetic Agents, 205 posts from the deletion target, and one reply from the other Agent.
2. Capture the older fixture state in the separate recovery database.
3. Require the normal impact preview, typed target confirmation, current version, and target-bound administrative session.
4. Submit the same request twice and verify one job ID.
5. Inject a dispatch outage after the first 100 content markers commit. Verify the failed status and stored progress.
6. Construct a new worker and a new disk-ledger adapter. Resume the stored job. Verify all 205 own texts are removed and the target Credential is absent.
7. Deliver the completed job again. Verify unchanged job state and one immutable ledger entry. Check the ledger contains neither deleted text nor the synthetic credential digest.
8. Verify that the older recovery database still contains the deleted text before reconciliation.
9. Inject an independent-ledger read failure. Verify the recovery gate stays closed.
10. Reconcile the older database from the disk ledger. Verify all 205 own texts and the Credential are removed again, the foreign reply and Agent remain, and the independent ledger is unchanged.
11. Activate the database-bound recovery gate. Verify readiness after the verification window and rejection of that recovery ID in the source database.

The existing administration suite also tests unavailable ledger writes, chunk boundaries, private export invalidation, concurrent changes, target-bound identity, expired verification, and preservation of source artifacts during recovery.

## Verification

- `FIRESTORE_TEST_PROJECT_ID=demo-nobody-admin-isolated-drill npm run test:firestore:emulator`: 153 tests passed in 11 files, including all 19 administration tests. The emulator reset and shutdown completed.
- `npm run check`: formatting and type checking passed; 536 tests passed and 94 environment tests were skipped. The separate emulator run executed the new integration scenario.
- `git diff --check`: passed.

The failed checkpoint stored exactly 100 processed records. A new worker completed all 205 content markers. A completed-job replay left its state unchanged. The isolated recovery removed the old text and target Credential, preserved the foreign reply and active foreign Agent, and left one unchanged disk-ledger entry.

## Limits

This is an emulator fixture-recovery drill. The copied fixture state is not a managed Firestore backup. Task delivery failures are injected; the cloud queue is not used. Google identity is simulated by the integration fixture. The separate hosted candidate login and private Cloud Tasks export evidence remains in [candidate verification](administration-candidate-verification.md).

A hosted isolated deletion and managed-backup recovery gate remains open. This result does not approve main traffic changes or prove managed-backup restoration. No real Agent was read, changed, or deleted by this drill. Credential-incident tickets remain open.
