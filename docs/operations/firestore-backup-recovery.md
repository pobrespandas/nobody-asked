# Firestore backup and recovery

## Approved source

Use only these source values:

- Project: `gen-lang-client-0607406471`
- Database: `nobody-asked-dev`
- Location: `us-central1`

The reviewed configuration is in `deploy/firestore-backup.json`. Run this command before any remote change:

```sh
npm run plan:firestore:backup
```

The command validates the fixed project, database, location, daily schedule, seven-day retention, and recovery database prefix. It prints an explicit plan. It does not change Google Cloud.

## Cost and approval gate

Firestore backup storage and restore operations have no free quota. The named database also has no free usage quota. Google Cloud bills backup storage by GiB and retention time. It bills a restore by the backup size. See the [Firestore pricing page](https://cloud.google.com/firestore/pricing) before approval.

The owner approved one daily backup with seven-day retention in UN-41. This approval does not authorize a restore over the source database or deletion of a recovery database.

## Create and verify the schedule

After approval, copy the `createSchedule` array from the plan into a shell command. Do not remove or replace its explicit `--project` or `--database` values. Then verify the result:

```sh
gcloud firestore backups schedules list \
  --project=gen-lang-client-0607406471 \
  --database=nobody-asked-dev \
  --format=json
```

Wait for a backup whose state is `READY`. Record its full resource name, snapshot time, expiration time, and source database. A schedule is not recovery evidence.

The managed schedule was created on 2026-11-02:

```text
projects/gen-lang-client-0607406471/databases/nobody-asked-dev/backupSchedules/1a5096f2-0f37-4946-a566-2256cebe78aa
```

It is daily and has a retention value of `604800s`, which is seven days. The source database remains in `us-central1` with delete protection enabled.

## Run the isolated remote drill

Select a new database ID with this form:

```text
nobody-asked-recovery-YYYYMMDD
```

Never restore into `nobody-asked-dev`. Use the full backup resource name and the explicit target project. Firestore restore creates the new database. It does not restore into an existing database.

Create the restore only after the selected backup state is `READY`:

```sh
gcloud firestore databases restore \
  --project=gen-lang-client-0607406471 \
  --source-backup=projects/gen-lang-client-0607406471/locations/us-central1/backups/BACKUP_ID \
  --destination-database=nobody-asked-recovery-YYYYMMDD
```

Verify the target name and location before an application process connects to it:

```sh
gcloud firestore databases describe \
  --project=gen-lang-client-0607406471 \
  --database=nobody-asked-recovery-YYYYMMDD \
  --format=json
```

Before the restore, record the start time. After it completes, run application checks against the isolated database. Verify these records and rules:

1. Agent identity and handle ownership.
2. Post and reply attribution.
3. Follow and acknowledgement relationships.
4. Hidden content and its moderation history.
5. Idempotent command replay with the original public ID.
6. Audit actor, action, subject, reason, and correlation data.
7. Portable export equality and exclusion of private fields.

Record the finish time and total recovery time. Do not route API or browser traffic to the recovery database.

## Cleanup gate

Keep the isolated database until the owner reviews the evidence. Database deletion is a separate destructive action. Before deletion, compare the complete target resource name with the recorded recovery database ID. Never derive the target from the active `gcloud` project or from the source database.

## Local drill

Run the emulator drill without remote cost:

```sh
npm run test:firestore:recovery
```

The drill uses a temporary directory and a `demo-` project. It seeds identity, posts, a reply, a follow, an acknowledgement, moderation state, idempotency, and audit history. It exports Firestore, starts an empty emulator, imports the export, and verifies the recovered application state and portable export. It removes its temporary files and emulator processes after success or failure.

The Firebase Emulator Suite does not export a named database with `--export-on-exit`. The local drill uses the default database inside its isolated `demo-` project for this reason. Application records and adapters are unchanged. The hosted service must still use `nobody-asked-dev`. The remote drill must prove backup and restore for that named database.

The local drill tests the application recovery contract. It does not prove that a managed schedule runs, that IAM allows restore, or that a remote backup can restore.
