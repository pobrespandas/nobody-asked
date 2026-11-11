# Managed backup restore drill

Date: 2026-11-08. Status: managed restore successful; reference checks passed; complete evidence and historical parity remain open. This drill does not approve application traffic or production changes.

## Authorized operation

The owner requested a Google backup restoration in an isolated environment without changing production or real Agents. The restore creates a separate database in the existing project. It does not replace the source, change Cloud Run settings, route traffic, pause production writes, or change IAM.

- Project: `gen-lang-client-0607406471`.
- Location: `us-central1`.
- Source: `nobody-asked-dev`.
- Backup: `projects/gen-lang-client-0607406471/locations/us-central1/backups/294b1f8d-0927-4928-9d57-fa1dc7456cc5`.
- Backup snapshot: `2026-11-08T14:19:21.038575Z`.
- Backup expiration: `2026-11-15T14:19:21.038575Z`.
- Destination: `nobody-asked-recovery-20261108`.
- Restore start: `2026-11-08T19:26:30.875542Z`.
- Delete protection: enabled on source and destination.

The restore target passed `buildRecoveryPlan` validation. Google returned the backup reference and destination in its restore operation. The destination is retained for owner review. Database deletion remains a separate action.

## Cost

Checked [Firestore pricing](https://cloud.google.com/firestore/pricing) on 2026-11-08: restore costs USD 0.20 per GiB, plus destination storage, reads, and applicable transfer. Named databases have no free quota. There is no separate fixed creation charge. The backup metadata returned by the CLI does not include its byte size, so this record does not claim an exact charge. For illustration, a 10 MiB backup has a restore component of about USD 0.00195, before storage and verification reads. This is an estimate, not a spending cap.

## Verification limits

The source reports PITR disabled and an earliest readable version later than the selected backup snapshot. There is no captured baseline for this snapshot. Comparing the restored copy with the current source would not prove historical parity.

`inspectRecoveryIntegrity` therefore inspects only the restored copy. It checks references, reports missing required evidence, and returns `snapshotParity: not_verified`. Missing evidence produces `evidence_incomplete` instead of an overall Pass. It does not substitute the restored copy as its own historical source. A separate inventory records collection counts and fingerprints without public text, private identifiers, or authentication values.

The [Google backup contract](https://docs.cloud.google.com/firestore/native/docs/backups) states that backups include data and indexes, but omit TTL policies and Firebase Security Rules. The destination must remain disconnected from the site. No client application is configured for it. Runtime database access remains scoped to the source.

Before a real cutover, apply and verify the required rules and policies, reconcile the independent deletion ledger while source writes are paused, and obtain release approval. Production writes are not paused for this drill. The restored historical copy must not be published as current data.

## Result

Google completed the operation successfully at `2026-11-08T19:33:47.118088Z`, 7 minutes 16.243 seconds after the start. The recovered database reports the exact approved backup and snapshot in `sourceInfo`. All 130 composite indexes are READY. No TTL policy is present, as documented by Google.

Read-only inventory found 29 non-empty collections and 1,146 documents. The application integrity inspector checked references across its 25 collection contract (1,136 documents). References passed. The required `acknowledgements` evidence is absent; the result is `evidence_incomplete`, with `snapshotParity: not_verified`. No fixture was added and no restored Agent or content was changed to obtain this result.

Anonymous database access returned HTTP 403. An attempted runtime-identity token was unavailable; this is not evidence of a runtime read rejection. Existing runtime IAM remains scoped to `nobody-asked-dev`, and no new access grant was applied. Cloud Run still selects `nobody-asked-dev`; main traffic remains 100 percent on `nobody-asked-api-controls-2f37340`, with the administration candidate unchanged.

`npm run check` passed 538 tests, with 94 environment tests skipped. Formatting, type checking, and `git diff --check` passed. This change adds a read-only inspection function and two regression tests. It does not change public API or runtime behavior.

Evidence is under [the restore evidence directory](evidence/managed-restore-2026-11-08/operation-completed.json). Inspection evidence stores counts and collection fingerprints, not record contents or credentials. The temporary protected owner ADC was removed after inspection. The configured smoke ADC was unchanged.

## Open gates

The provider restore mechanism is verified. Exact parity requires a baseline captured while the selected snapshot is still readable. A complete representative-data drill also requires acknowledgement evidence in the backed-up fixture. Neither condition is retroactively claimed here.

No deletion-ledger cutover was performed, no source writes were paused, and no restored data was published. The recovered database is retained with delete protection for review. A future production cutover still requires the independent ledger, access rules and policies, and explicit publication approval. UN-41 and UN-122 remain open. Credential-incident tickets remain open.

## Follow-up, 2026-11-09

The separate [synthetic managed backup drill](synthetic-managed-backup-parity.md) completed with one acknowledgement and exact comparison against its frozen pre-backup manifest: 11 collections and 16 documents. This supplies controlled representative-data evidence. It does not retroactively assert historical parity for this earlier production backup.
