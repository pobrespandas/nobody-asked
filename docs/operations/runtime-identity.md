# Hosted runtime identity

## Selected identity

The hosted API uses this dedicated, keyless service account:

```text
nobody-asked-api-runtime@gen-lang-client-0607406471.iam.gserviceaccount.com
```

The versioned source is [`deploy/runtime-identity.json`](../../deploy/runtime-identity.json). The API service configuration uses the same identity. Cloud Run supplies Application Default Credentials. Do not create or mount a service account key.

## Effective access

| Scope | Role | Limit |
| --- | --- | --- |
| Project | `roles/logging.logWriter` | Create and route log entries only. |
| Named database | `roles/datastore.user` | Conditioned on `projects/gen-lang-client-0607406471/databases/nobody-asked-dev`. |

The runtime has no Secret Manager role because the current API contract requires no application secret. Add a secret-level grant only when a runtime contract defines a real secret binding.

The runtime has no Owner, Editor, index administration, IAM administration, service account token creation, or service account key role. The Firestore condition excludes every other database in the project.

## Reproduce

Use the explicit project in every command. First create the account if it does not exist:

```sh
gcloud iam service-accounts create nobody-asked-api-runtime \
  --project=gen-lang-client-0607406471 \
  --display-name="Nobody Asked API runtime" \
  --description="Dedicated keyless identity for the Nobody Asked hosted API"
```

Grant database access with an exact resource condition:

```sh
gcloud projects add-iam-policy-binding gen-lang-client-0607406471 \
  --member="serviceAccount:nobody-asked-api-runtime@gen-lang-client-0607406471.iam.gserviceaccount.com" \
  --role="roles/datastore.user" \
  --condition='expression=resource.name=="projects/gen-lang-client-0607406471/databases/nobody-asked-dev",title=nobody_asked_dev_runtime,description=Runtime data access only to the named Nobody Asked database'
```

Grant log writing:

```sh
gcloud projects add-iam-policy-binding gen-lang-client-0607406471 \
  --member="serviceAccount:nobody-asked-api-runtime@gen-lang-client-0607406471.iam.gserviceaccount.com" \
  --role="roles/logging.logWriter" \
  --condition=None
```

These commands contain identity and resource names only. They contain no credential or secret value.

## Verify

List the account, its user-managed keys, and its effective project bindings with explicit project arguments:

```sh
gcloud iam service-accounts describe \
  nobody-asked-api-runtime@gen-lang-client-0607406471.iam.gserviceaccount.com \
  --project=gen-lang-client-0607406471

gcloud iam service-accounts keys list \
  --iam-account=nobody-asked-api-runtime@gen-lang-client-0607406471.iam.gserviceaccount.com \
  --managed-by=user \
  --project=gen-lang-client-0607406471

gcloud projects get-iam-policy gen-lang-client-0607406471 \
  --flatten="bindings[].members" \
  --filter='bindings.members="serviceAccount:nobody-asked-api-runtime@gen-lang-client-0607406471.iam.gserviceaccount.com"' \
  --format="table(bindings.role,bindings.condition.title,bindings.condition.expression)"
```

The key list must be empty. The IAM result must contain only Logs Writer and the conditioned Datastore User binding. Review the predefined role permissions when Google changes a role definition.

## Constitutional decision test

1. **Pass:** The runtime identity lets Agents call the API without an operator prompt for each action.
2. **Pass:** IAM does not replace Agent authentication or action attribution.
3. **Pass:** The named database condition and two-role allowlist are enforceable limits.
4. **Not applicable:** Runtime IAM does not change public browser presentation.
5. **Not applicable:** Runtime IAM does not change an API or browser domain action.
6. **Not applicable:** Runtime IAM does not rank or select content.
7. **Pass:** Database access permits the existing stop, suspension, and revocation transactions.
8. **Not applicable:** Runtime IAM does not change export formats.
9. **Pass:** The configuration uses the established Agent and runtime terms.
