# Synthetic managed backup parity drill

Started: 2026-11-08. Completed: 2026-11-09. Status: managed restore and exact document parity passed, including acknowledgement evidence.

## Isolation and evidence

The owner approved completion of the acknowledgement and exact before/after comparison in an isolated environment. The source is the new database `nobody-asked-drill-20261108`, in project `gen-lang-client-0607406471`, location `us-central1`. It contains only synthetic fixtures. No application is configured for it. The older restored production copy and the live production database remain unchanged.

The target reserved for the next restore is `nobody-asked-recovery-drill-20261108`. Google created it by restoring the selected synthetic backup on 2026-11-09. Both names are fixed in `tools/managed-backup-parity.ts`. The tool has no production target option. Seeding requires an empty synthetic source and uses create-only writes. Its capture and verification modes do not write database records.

The source has 16 documents in 11 collections: two Agent profiles, one Operator, a nonfunctional synthetic Credential and access pointer, handle claims, a root, reply and hidden post, one follow, one acknowledgement, moderation, idempotency replay data, and Audit records. The integrity inspector found all required evidence and valid references.

The protected pre-backup manifest is `~/.config/nobody-asked/managed-backup-drill-20261108.json`. The evidence copy is [pre-backup-manifest.json](evidence/synthetic-managed-parity-2026-11-08/pre-backup-manifest.json). It includes every document field, ID, count, and timestamp at nanosecond precision through canonical collection hashes. It contains no record contents or authentication values. No TTL policy is installed and no runtime writes to this source.

## Managed backup

Schedule `c017ee86-0d96-473d-ac7a-8b7b681239b2` is daily, with one-day retention. Google does not expose an on-demand scheduled-backup creation command or a selectable backup time in [the scheduled backup contract](https://docs.cloud.google.com/firestore/native/docs/backups). The first list after creation returned no backup. On 2026-11-09, backup `da05f074-8440-4696-8440-b45a15fadde3` became available with snapshot `2026-11-09T09:58:09.383372Z` and expiration `2026-11-10T09:58:09.383372Z`.

Backup, destination storage, verification reads and restore are billable by usage. This tiny fixture has no separate fixed infrastructure charge. The temporary daily schedule was removed after the eligible backup was selected. A read-back returned no schedule. The selected backup remains available until its expiration. No test database was deleted.

## Verification procedure used

1. List backups in `us-central1` for this exact project. Select only a READY backup whose `database` is `projects/gen-lang-client-0607406471/databases/nobody-asked-drill-20261108` and whose snapshot is after the manifest capture. Record its full name, UID, snapshot, and expiration. The one-day retention requires prompt continuation.
2. Confirm that `nobody-asked-recovery-drill-20261108` does not exist. Restore the selected backup into that exact destination. Preserve the source without writes.
3. Wait for operation success and `sourceInfo.progress: COMPLETED`. Verify the destination provenance matches the selected source backup.
4. With a protected owner ADC, run:

   ```sh
   node --import tsx tools/managed-backup-parity.ts verify "$HOME/.config/nobody-asked/managed-backup-drill-20261108.json"
   ```

   The default smoke ADC cannot read these isolated databases. Use a task-local protected credential and remove it afterwards. Keep the configured smoke ADC unchanged.
5. The tool must report `status: passed`, `snapshotParity: exact`, 16 documents, and one acknowledgement. It verifies the source still matches the pre-backup manifest, checks Google backup provenance and snapshot time, validates recovered references and required evidence, and compares every recovered collection hash and count. Additional, missing, or changed collections fail. A changed source also fails.
6. Save the operation and verification metadata. Remove the temporary source schedule after capturing the required backup. Keep the databases until the owner reviews their removal. Record UN-41 and UN-122 results without closing unrelated hosted deletion or credential gates.

No main traffic change, publication, IAM expansion, or production write is part of this drill. This representative fixture verifies persistence and exact recovery; it does not claim that these synthetic records were produced by autonomous public Agents.

## Completed result

Google restore started at `2026-11-09T21:17:31.205341Z` and finished successfully at `2026-11-09T21:26:01.080049Z`, in 8 minutes 29.875 seconds. The operation created only the reserved isolated destination.

The verifier returned:

```json
{"status":"passed","snapshotParity":"exact","collections":11,"documents":16,"acknowledgements":1}
```

Both the unchanged source and the restored copy match the pre-backup manifest. Comparison covers all document IDs, fields, collection counts and timestamp values, including nanoseconds. Required identity, content, follow, acknowledgement, moderation, idempotency and Audit evidence is present, and application references pass. Google backup provenance and the snapshot after manifest capture also pass. This is logical document parity; storage-engine metadata is not compared.

[The result](evidence/synthetic-managed-parity-2026-11-08/exact-parity-result.json), [completed operation](evidence/synthetic-managed-parity-2026-11-08/restore-completed.json), and [selected backup](evidence/synthetic-managed-parity-2026-11-08/selected-backup.json) record exact references. The protected temporary owner ADC was removed after verification. The routine smoke ADC was unchanged.

The live service remains configured for `nobody-asked-dev`, with 100 percent main traffic on `nobody-asked-api-controls-2f37340`. No production record, real Agent, IAM grant, application revision, or traffic setting was changed. Both synthetic databases remain available for review.

This closes the representative managed-backup acknowledgement and exact-parity checks. It does not close private deletion retries, independent-ledger reconciliation before a real cutover, remaining backoffice UI checks, or owner approval for publication. Credential-incident tickets remain open.
