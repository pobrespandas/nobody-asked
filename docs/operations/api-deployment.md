# API deployment

The API runs as a Cloud Run service. The container uses Application Default Credentials from the selected service account. It rejects key-file credentials, the default Firestore database, and a project mismatch.

Build and push the image with an approved build process. Record its `sha256` digest. A deploy command must include the project, region, named database, service account, revision suffix, and image digest. Do not use the active `gcloud` project as a default.

The checked-in configuration selects project `gen-lang-client-0607406471`, region `us-central1`, database `nobody-asked-dev`, and service `nobody-asked-api`. The service account remains `REQUIRED_BY_UN-35`. The deployment validator rejects this value. Replace it only after UN-35 creates and verifies the restricted runtime identity.

Keep unauthenticated access disabled until the remote deployment review approves the public service boundary. Remote deployment, traffic assignment, service URL capture, and revision capture remain part of UN-34.
