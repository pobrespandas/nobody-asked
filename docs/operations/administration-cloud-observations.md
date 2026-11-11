# Cloud observations in private administration

Status: local implementation. No publication or IAM change is part of this change.

Run `npm run observe:administration` with the explicit `NOBODY_ASKED_GCP_PROJECT_ID` and `FIRESTORE_DATABASE_ID` under the existing approved observation identity. This reads Cloud state and writes one private observation document. It does not change Cloud resources. Do not grant the application runtime Cloud management permissions.

The tool captures Cloud Run traffic, readiness and capacity; Firestore location, protection and point-in-time recovery configuration; Cloud Tasks state, rate and retry limits; and the latest ready backup. Page views read the capture. Read failures remain unavailable rather than zero. The tool does not collect actual spend, request latency, error rates or raw mail logs.

Read-only checks on 2026-11-11 confirmed the current API has a maximum of two instances, one CPU, 512 MiB, concurrency 80 and a 300-second timeout. The active queue is RUNNING, with one concurrent dispatch, one dispatch per second and 20 maximum attempts. Firestore has deletion protection enabled and point-in-time recovery disabled. These are observations, not changed settings or claims about future cost. Managed backups and point-in-time recovery are different controls.

Validation: see `/tmp/nobody-cloud-check.log` for the local check result. Hosted capture and release verification remain pending. The private page must show capture age and uncertainty. Never copy secret values, environment values, task bodies or raw logs into observations.

## Hosted capture verification, 2026-11-11

The existing gcloud identity captured the observation at 11:33:48 UTC (08:33 ART). Use `-- --gcloud-auth` to select that existing session explicitly when ADC is not suitable. The access token stays in memory. The normal ADC path remains available. No credential file or IAM grant is created. Capture readback passed and the published private Operations page displayed the saved fields. Its old JSON presentation remains until the new renderer is published.

The latest ready backup was `37851b99-d7a0-4f18-a0f1-fad6faa532a8`, from 2026-11-10 at 14:35:10 UTC, expiring on 2026-11-17 at 14:35:10 UTC. No restore was run. The local emulator preview displayed the same captured data with readable dates and fields; it has no connection to production for application actions.

Local check passed: 559 tests, 97 skipped. Source formatting, types and diff whitespace passed. Deployment of the new Operations renderer remains pending.
