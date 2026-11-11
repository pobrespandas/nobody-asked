# Private administration release

Date: 2026-11-10. Status: published and verified.

The owner explicitly approved publication and verification of the tested backoffice and Hosting configuration. This release uses the existing project, Cloud Run service, database, Hosting site, queue, ledger bucket, runtime identity, and secret references. It creates no project, application, or load balancer.

## Initial cutover

- Initial revision: `nobody-asked-api-admin-main-e49cc121`, 100 percent main traffic.
- Initial image: `sha256:6a572f1a60637ac01655773be2b7d78a9247c6a1530a474a25d576ea0944cac7`.
- Hosting version: `04c65418f6e23128`, six files.
- Backoffice: `https://nobodyasked.pobrespandas.com/admin`.
- Runtime Origin: `https://nobodyasked.pobrespandas.com`.
- Task URL and exact OIDC audience: `https://nobody-asked-api-b747s3o2ta-uc.a.run.app/internal/admin/jobs`.

All prepared runtime values and secret references matched the new revision before promotion. The existing rollback revision and Hosting version remain recorded in `deploy/admin-release.json` and the [rollback baseline](evidence/admin-hosted-drill-2026-11-10/rollback-baseline.json).

## Main-domain verification

Real owner Google sign-in and the same-site continuation passed through the custom domain. The cookie was Secure, HttpOnly, and SameSite=Strict. Twelve authenticated private read routes returned 200, no-store, and noindex. Checked responses excluded credential digests and recovery keys. Sign-out returned to the login page; reuse of that session returned 401. The temporary local copy of that session was removed.

Public homepage, discovery, and the existing conversation returned 200. The conversation contains no script element. All six hosted static files match the reviewed artifact hashes. Anonymous private access returns 401; normal browser access redirects to login. Private styles and pages retain the restrictive content policy.

A task from the isolated queue used the real task identity and exact stable production audience. Its deliberately empty body reached request validation and returned 400 on the serving revision. This verifies authentication and routing without requesting a job or changing an Agent. Missing and invalid assertions returned 401. The disposable task was removed and the isolated queue paused again.

The final error-path probe found `same-origin` on a rejected OAuth callback. Successful callbacks already used `no-referrer`. Source now applies `no-referrer` to rejected authentication responses too. The regression test confirms that the rejected code is absent from the response body. Full checks passed 545 tests, with 96 environment tests skipped. The correction changes only this response policy; it preserves permissions, identity binding, actions, and stored records.

## Final serving revision

Build `f7225aff-cac4-4054-bf87-354ee1ded482` succeeded from the 167-file source fingerprint `6b77e32235de5290e93c77a39e9f16b3f84a8693a9b23c7adb6be8a514331d05`. Final image: `sha256:317622c1bbd6d0a608859754dc8163229601ccd2cd86d49334dbd6307c566ca3`. Revision `nobody-asked-api-admin-main-6b77e322` receives 100 percent main traffic. All prepared runtime settings and secret references match.

Readiness and rejected-callback privacy passed at zero main traffic before final promotion. The main-domain rejected callback now returns 401 with `no-referrer`. Real Google sign-in, continuation, all twelve private read checks, and logout passed again on the final revision. The logged-out session returned 401 and its temporary local copy was removed. Hosting remains on `04c65418f6e23128`; the correction changed no static file.

The old candidate queue was empty before the `admin-preview` tag was retired. The isolated queue is empty and paused. The final `admin-release` tag points to the same revision as main traffic. The fixed image retains the isolated deletion/recovery evidence because only authentication error response headers changed. No domain, storage, migration, or worker change is included in that final correction.

## Evidence and limits

[Hosted release evidence](evidence/admin-main-release-2026-11-10/) records HTTP results, private-read checks, logout, task delivery, static-file hashes, traffic, Hosting configuration, and a screenshot. It excludes session cookies, provider codes, and tokens. The [isolated hosted drill](administration-hosted-drill.md) remains the evidence for deletion, retries, managed synthetic restore reconciliation, and mobile forms. No production deletion, restore, real-Agent change, or email send ran for this publication.

UN-122 is Done with structured release evidence. Credential incidents remain open. This backoffice release does not close the separate first-release operational review. No Git commit, push, or npm release is part of this publication.
