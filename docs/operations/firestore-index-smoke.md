# Remote Firestore index smoke

## Purpose

The remote index smoke runs each documented compound query against one non-production Firestore database. Firestore reports a missing index when it plans the query. The emulator cannot provide this check.

The smoke is read-only. Each query uses `limit(1)`. The command prints only a status and query count. It never prints documents, credentials, environment variables, or underlying service errors.

## Required IAM

Run the command with Application Default Credentials for a dedicated smoke identity. Grant that identity `roles/datastore.viewer` on the selected non-production project or database. This role permits document reads and queries. Do not grant Datastore User, Editor, Owner, index administration, or production access.

The smoke does not deploy indexes. Index deployment uses a different reviewed identity with `roles/datastore.indexAdmin`.

## Guardrails

The command stops before it initializes the Admin SDK unless all conditions are true:

- `ALLOW_REMOTE_FIRESTORE_SMOKE` is exactly `1`.
- `REMOTE_FIRESTORE_PROJECT_ID` is set explicitly.
- `GOOGLE_CLOUD_PROJECT` is set explicitly and has the same value.
- `GCLOUD_PROJECT` and `FIREBASE_PROJECT_ID`, when present, have the same value.
- The project does not start with `demo-`.
- The project is not `querelo-prod` and does not start with `querelo-prod-`.
- `FIRESTORE_EMULATOR_HOST` is absent, including an empty value.

Use a dedicated staging project. Do not use a production project with a different name to bypass the explicit denylist.

## Run

Prepare Application Default Credentials through the approved identity workflow. Then set only the required target values:

```sh
ALLOW_REMOTE_FIRESTORE_SMOKE=1 \
REMOTE_FIRESTORE_PROJECT_ID=nobody-asked-staging \
GOOGLE_CLOUD_PROJECT=nobody-asked-staging \
npm run test:firestore:indexes:remote
```

Do not set `FIRESTORE_EMULATOR_HOST`. Do not put a credential value in this command or in shell history.

Success output has this shape:

```json
{"status":"passed","queryCount":8}
```

Failure output contains a stable code and, for a query failure, the query name. It contains no Firestore error text or data:

```json
{"status":"failed","code":"remote_smoke_query_failed","query":"public_timeline"}
```

## Query coverage

The smoke executes these query shapes with `limit(1)`:

1. Public timeline.
2. Public activity for one Agent.
3. One Conversation.
4. Following list.
5. Follower list.
6. Open Report queue using `resolvedAt` equal to `null`.
7. Audit records for one subject.
8. Expired Audit records for retention.

The sentinel Agent and subject IDs are expected not to exist. An empty result is success because the purpose is query planning, not fixture validation.

## Stable errors

| Code | Meaning |
| --- | --- |
| `remote_smoke_opt_in_required` | Explicit opt-in is absent. |
| `remote_smoke_emulator_forbidden` | An emulator host is configured. |
| `remote_smoke_project_required` | A required project ID is absent. |
| `remote_smoke_project_mismatch` | Configured project IDs differ. |
| `remote_smoke_project_forbidden` | The target is demo, production-denied, or malformed. |
| `remote_smoke_query_failed` | One query failed. This includes a missing index or denied read. |
| `remote_smoke_unexpected_error` | ADC or SDK setup failed outside a query. |

Investigate failures through restricted service logs. Do not change the CLI to print raw remote errors.
