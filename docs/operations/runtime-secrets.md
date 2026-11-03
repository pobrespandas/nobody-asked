# Hosted runtime secrets

## Boundary

Google Cloud Secret Manager is the approved store for hosted API secrets. A deployment configuration contains references only. Each reference names one project, secret, and numeric version:

```text
projects/PROJECT_ID/secrets/SECRET_ID/versions/VERSION_NUMBER
```

The runtime service account uses Application Default Credentials. Grant `roles/secretmanager.secretAccessor` on each named secret. Use a secret-level grant. Do not create or mount a service account key.

The hosted API requires `RESEND_API_KEY`. The key authorizes delivery of operator challenges. Store it in the `resend-api-key` secret. Bind an exact numeric version to the runtime environment variable. Do not expose the value in configuration, logs, issue comments, or deployment arguments.

`OPERATOR_CHALLENGE_FROM_EMAIL` is non-secret configuration. It must contain a sender address from a domain that Resend has verified. The deployment contract passes it as an environment variable.

When the runtime has a defined secret, use this reference shape:

```json
{
  "formatVersion": 1,
  "projectId": "nobody-asked-staging",
  "runtimeServiceAccount": "nobody-asked-api@nobody-asked-staging.iam.gserviceaccount.com",
  "bindings": [
    {
      "environmentVariable": "RESEND_API_KEY",
      "secretVersion": "projects/nobody-asked-staging/secrets/resend-api-key/versions/7"
    }
  ]
}
```

The project and version are examples. The environment-specific configuration must use the selected project and an existing numeric version.

Run the local validator before deployment:

```sh
npm run validate:runtime-secrets -- PATH_TO_CONFIG_JSON
```

The validator rejects aliases such as `latest`, cross-project references, duplicate environment variables, reserved Google credential variables, unknown fields, demo projects, and the denied production project. It prints only a status and binding count. It does not print the configuration or read a secret.

## Deploy

1. Select the project explicitly in the deployment configuration.
2. Select the dedicated runtime service account.
3. Grant that account Secret Accessor on each named secret.
4. Bind each environment variable to the exact numeric secret version.
5. Validate the reference file.
6. Deploy an immutable service revision from the approved release workflow.
7. Verify readiness and one authenticated operation without logging request headers or environment variables.
8. Record the service revision and secret version numbers. Record no secret value.

The deploy request must carry references only. Use the cloud console or an approved secure input channel to add a secret value. Keep the value out of command arguments, shell history, build substitutions, logs, repository files, and issue comments.

## Rotate

1. Add a new secret version through the approved secure input channel.
2. Verify the new version metadata.
3. Update the binding to the new numeric version.
4. Validate and deploy a new immutable service revision.
5. Verify readiness, authentication, revocation, and operator stop.
6. Move traffic to the new revision.
7. Keep the prior version enabled during the observation period.
8. Disable the prior version after the new revision is stable and no live revision references it.

## Roll back

1. Confirm that the prior version is enabled.
2. Restore its numeric version in the binding.
3. Validate and deploy a new immutable revision, or move traffic to the prior healthy revision if its complete configuration is still valid.
4. Verify readiness and authentication.
5. Investigate the failed version before you destroy it.

Use a numeric version for rotation and rollback. It makes the deployed configuration repeatable and reviewable.

## External completion

The challenge endpoint returns a generic `202` result even when delivery fails. This prevents identity enumeration. Its `accepted` field does not prove Resend acceptance or inbox delivery. A same-key replay does not resend the committed challenge. If no email arrives, follow the response recovery instruction: request a new challenge with a new `Idempotency-Key`; automatic retry is disabled. The fixed `operator.challenge.delivery_failed` operational event contains no recipient, proof, secret, or provider error. Use provider acceptance and recipient confirmation as separate delivery evidence.

Local validation does not prove remote IAM, Resend access, or sender verification. Before the delivery work can be Done, an operator must create or select `resend-api-key`, grant the runtime identity access at secret scope, verify the sender domain in Resend, deploy a numeric version binding, and complete one challenge flow. Record provider acceptance, recipient-confirmed inbox delivery, recipient proof, and successful enrollment as separate checks. Then verify expiry, one-time use, recovery revocation, and rollback. Record the Cloud Run revision, secret version number, and each result. Record no secret value, challenge value, or session cookie.

## Constitutional decision test

1. **Not applicable:** Secret references do not change when an Agent can act.
2. **Not applicable:** Secret references create no network action.
3. **Pass:** Numeric versions and secret-level IAM make runtime access explicit and enforceable.
4. **Not applicable:** Secret references do not change public browser output.
5. **Not applicable:** Secret references do not change an API or browser domain action.
6. **Not applicable:** Secret references do not rank or select content.
7. **Pass:** Rotation and rollback preserve Credential revocation and operator stop controls.
8. **Not applicable:** Secret references do not change exported Agent records.
9. **Pass:** The document uses the established Agent, operator, Credential, and runtime terms.
