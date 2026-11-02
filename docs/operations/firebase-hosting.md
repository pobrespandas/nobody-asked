# Firebase Hosting

The production browser uses site `nobodyasked-pobrespandas-prod` in project `gen-lang-client-0607406471`. The deploy command must name both values through the configured target. Do not use the active Firebase or Google Cloud project.

Build and deploy:

```sh
npm run build --workspace @nobody-asked/browser
npx firebase-tools deploy --project gen-lang-client-0607406471 --only hosting:nobodyasked-production
```

Hosting serves `dist/browser`. It sends `/v1/**` to Cloud Run service `nobody-asked-api` in `us-central1`. All other routes serve `index.html`. The browser does not access Firestore.

## Verify the custom domain

The production custom domain is `nobodyasked.pobrespandas.com`. Its Cloudflare record must be DNS-only. A proxied record hides the Firebase target and can prevent Firebase from validating the domain.

Verify the public CNAME:

```sh
dig +short CNAME nobodyasked.pobrespandas.com @1.1.1.1
```

The only answer must be `nobodyasked-pobrespandas-prod.web.app.`. A public CNAME answer also confirms that Cloudflare does not proxy the record.

Verify the Firebase domain and certificate state. The quota header keeps the request tied to the fixed production project:

```sh
curl --fail --silent --show-error \
  --header "Authorization: Bearer $(gcloud auth print-access-token)" \
  --header "x-goog-user-project: gen-lang-client-0607406471" \
  "https://firebasehosting.googleapis.com/v1beta1/projects/gen-lang-client-0607406471/sites/nobodyasked-pobrespandas-prod/customDomains/nobodyasked.pobrespandas.com"
```

Completion requires `hostState` to be `HOST_ACTIVE`, `ownershipState` to be `OWNERSHIP_ACTIVE`, `cert.state` to be `CERT_ACTIVE`, and `issues` to be empty.

Verify the redirect, TLS name, and public page:

```sh
curl --head --silent --show-error http://nobodyasked.pobrespandas.com/
echo | openssl s_client \
  -connect nobodyasked.pobrespandas.com:443 \
  -servername nobodyasked.pobrespandas.com \
  -verify_hostname nobodyasked.pobrespandas.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
curl --fail --silent --show-error \
  --output /dev/null \
  --write-out '%{http_code}\n' \
  https://nobodyasked.pobrespandas.com/
```

The HTTP response must redirect to the same path on HTTPS. The certificate must contain `nobodyasked.pobrespandas.com`. The final HTTPS request must return `200`. A valid certificate with a Firebase `404 Site Not Found` response means that the domain is active but the site has no live release.

List releases before a rollback. The command uses an explicit Hosting resource. It does not read the active project:

```sh
curl --fail --silent --show-error \
  --header "Authorization: Bearer $(gcloud auth print-access-token)" \
  --header "x-goog-user-project: gen-lang-client-0607406471" \
  "https://firebasehosting.googleapis.com/v1beta1/projects/gen-lang-client-0607406471/sites/nobodyasked-pobrespandas-prod/releases?pageSize=10"
```

Copy the prior `version.name` from that response. Create a rollback release with that complete version name:

```sh
curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer $(gcloud auth print-access-token)" \
  --header "x-goog-user-project: gen-lang-client-0607406471" \
  "https://firebasehosting.googleapis.com/v1beta1/projects/gen-lang-client-0607406471/sites/nobodyasked-pobrespandas-prod/releases?versionName=VERSION_NAME"
```

After each deploy or rollback, open `https://nobodyasked-pobrespandas-prod.web.app`. Verify the page, a direct browser route, response headers, and one `/v1/` request.
