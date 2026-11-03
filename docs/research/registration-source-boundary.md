# Registration source boundary

Review date: 2026-11-02. This review supports UN-81. It does not authorize a deployment or an ingress change.

## Current evidence

The runtime binds the Node socket peer address to the Request through a private WeakMap. Registration uses a hash of that value. It ignores forwarding headers. Requests without valid transport metadata share the unknown bucket.

The repository configures Firebase Hosting rewrites for `/v1` and `/v1/**` to `nobody-asked-api` in `us-central1`. A read-only Cloud Run service inspection on the review date returned ingress `all` and an enabled `run.app` URL. Thus the current service has a direct ingress path as well as Hosting.

The [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract#transport-layer-encryption-tls) says that Cloud Run terminates TLS and proxies HTTP to the container. The socket peer therefore does not establish the original internet client's identity.

The [Firebase Hosting configuration contract](https://firebase.google.com/docs/hosting/full-config#rewrite-cloud-run) documents Cloud Run rewrites. It does not specify an authenticated original-client header, a fixed trusted forwarding-hop count, or a header overwrite guarantee for this complete request path.

The [Application Load Balancer header contract](https://docs.cloud.google.com/load-balancing/docs/https#x-forwarded-for_header) documents appending client and forwarding-rule addresses after any existing X-Forwarded-For values. Values before that suffix are unverified. Backend proxies can append further addresses. That contract does not establish a fixed suffix for Firebase Hosting plus Cloud Run.

The [Cloud Run ingress contract](https://docs.cloud.google.com/run/docs/securing/ingress) documents direct and load-balancer ingress paths. It also warns that Firebase Hosting uses the default URL. Disabling that URL without a replacement architecture can break Hosting integration.

## Decision

Keep socket-peer selection. Do not enable a trusted-header mode for the current deployment. No reviewed provider contract proves which header position identifies the original client across both direct Cloud Run and Firebase Hosting requests.

This is an availability limitation: unrelated clients behind one proxy can share the source limit. It is not a claim of independent per-client hosted limits. Global and incomplete-registration limits still apply. A caller cannot obtain another source bucket by changing X-Forwarded-For, Forwarded, X-Real-IP, CF-Connecting-IP, or Fastly-Client-IP.

## Compliant future design

Use an owned ingress that derives the client address from its transport peer, replaces the source header rather than appending caller input, and authenticates requests to the backend. Restrict every alternative backend ingress path. Review Firebase Hosting compatibility before any such restriction.

Only then add an explicit configured trust mode with the exact authenticated proxy identity and overwritten-header contract. Reject malformed or missing trusted metadata into the shared unknown bucket. Verify direct-path bypass rejection and spoofed-header behavior against the deployed candidate before enabling the mode.

No ingress, IAM, traffic, DNS, or remote record changed during this review.
