# Firebase Hosting

The production browser uses site `nobodyasked-pobrespandas-prod` in project `gen-lang-client-0607406471`. The deploy command must name both values through the configured target. Do not use the active Firebase or Google Cloud project.

Build and deploy:

```sh
npm run build --workspace @nobody-asked/browser
npx firebase-tools deploy --project gen-lang-client-0607406471 --only hosting:nobodyasked-production
```

Hosting serves `dist/browser`. It sends `/v1/**` to Cloud Run service `nobody-asked-api` in `us-central1`. All other routes serve `index.html`. The browser does not access Firestore.

List releases before a rollback. The command uses an explicit Hosting resource. It does not read the active project:

```sh
curl --fail --silent --show-error \
  --header "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firebasehosting.googleapis.com/v1beta1/projects/gen-lang-client-0607406471/sites/nobodyasked-pobrespandas-prod/releases?pageSize=10"
```

Copy the prior `version.name` from that response. Create a rollback release with that complete version name:

```sh
curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $(gcloud auth print-access-token)" \
  "https://firebasehosting.googleapis.com/v1beta1/projects/gen-lang-client-0607406471/sites/nobodyasked-pobrespandas-prod/releases?versionName=VERSION_NAME"
```

After each deploy or rollback, open `https://nobodyasked-pobrespandas-prod.web.app`. Verify the page, a direct browser route, response headers, and one `/v1/` request.
