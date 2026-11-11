# Administration cloud preflight

Date: 2026-11-07. All cloud checks were read-only. No resources were created and no traffic was changed.

## Current state

- Project: `gen-lang-client-0607406471` (pobrespandas).
- Service: `nobody-asked-api`, region `us-central1`.
- Main traffic: 100 percent on `nobody-asked-api-controls-2f37340`.
- Runtime identity: the existing `nobody-asked-api-runtime` service account.
- Google Auth Platform has not been configured in this project. Its Clients page shows the initial setup screen.
- Cloud Tasks API is disabled. The read-only queue inventory did not enable it.
- Secret Manager lists the existing iCloud SMTP and Resend resources. There is no Administrator OAuth secret resource.
- The Cloud SDK storage command failed under its default Python interpreter. The read-only inventory uses `CLOUDSDK_PYTHON=/Users/andrestobelem/.local/bin/python3.13` instead. No global SDK configuration was changed.

## Candidate routing

[The candidate manifest](../../deploy/admin-candidate.json) fixes the candidate tag, callback, Origin, queue target, scopes, and secret resource name. It contains no client secret.

Use the candidate URL as `ADMIN_ORIGIN` and as the prefix of `ADMIN_TASK_URL` during zero-main-traffic verification. The currently published revision does not serve the new administration routes. Sending callbacks or queue requests to its default URL would test the wrong runtime.

Register the candidate, production, and bootstrap callback URLs on the same approved web client. Set the expected owner as an OAuth test user while the Google application is in testing. Reuse the project's existing brand direction; do not create a new Cloud project.

After candidate verification, prepare a separate production-configured revision from the same image. Verify callback and queue routing before switching main traffic. Keep the candidate tag until its queued work has drained. Main traffic promotion and Hosting publication require a separate approval.

## Approval package

The next approved action would configure Google Auth Platform and its web client, create the declared queue and private bucket, apply narrow runtime permissions and the callback log exclusion, prepare indexes, build the reviewed source, and deploy the tagged candidate at zero main traffic. It would not change the public site's main traffic or perform a restore.

Resource settings and permission boundaries are in [admin-resources.json](../../deploy/admin-resources.json). The [cost estimate](administration.md#incremental-cost-estimate) describes variable charges. Its example adds about USD 0.20 per month for metric writes at 100,000 requests and 10,000 new items, plus storage, queue execution, other database operations, and applicable compute. This is an estimate, not a cap or a zero-cost guarantee. There is no new load balancer or fixed monthly infrastructure fee in this design.

The owner must complete the real Google authorization during controlled bootstrap. Secrets remain outside chat, source files, command arguments, and logs. Credential-incident tickets remain open.
