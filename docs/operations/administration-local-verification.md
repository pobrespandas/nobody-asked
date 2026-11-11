# Administration local verification

Date: 2026-11-07. Status: local working tree. No production deployment.

Base commit: `81676cdf35cea3ac390c80827b35a578b9bbb176`.
Administration source fingerprint: `2c8ac501461b425c7791833a24e16524e69ca8cee1245000b07490932d226678`.
Compute it by hashing each sorted `apps/api/src/admin/*.ts` path followed by its file bytes. This fingerprint includes the administration tests. It is not a release commit.

## Results

- `npm run check`: Pass. 536 tests passed. Integration-only tests remain skipped in this gate.
- `npm run test:firestore:emulator`: Pass. 151 tests passed in the complete emulator run, including the then-current 17 administration tests.
- Final targeted administration emulator run: Pass. 18 tests passed. This adds isolated recovery and export invalidation coverage to the complete run.
- `npm run test:packaged`: Pass. A temporary clean install compiled and ran the packaged public Agent flow against an isolated emulator. It does not verify a hosted Administrator login.
- `npm run build -- --outDir /tmp/nobody-admin-build-final`: Pass.
- `git diff --check`: Pass.
- Desktop browser: the local normal form submitted suspension and returned by redirect to a profile with `status=suspended`.
- JavaScript-disabled browser: sign-in through the explicitly simulated local provider and navigation from Overview to Agents succeeded. The browser used `javaScriptEnabled=false` and a 390 by 844 mobile viewport. Screenshots are local artifacts under `output/playwright/`.

The browser form exposed an Origin-header regression from `Referrer-Policy: no-referrer`. Private documents now use `same-origin`. OAuth redirect responses keep `no-referrer`. Hosting has matching overrides.

## Covered risks

Tests cover bootstrap exclusivity, Google binding, OAuth state consumption and browser binding, ordinary Operator denial, CSRF and Origin checks, recent authentication, expired-window sign-out, private projections, filter-bound cursors, conflicting writes, revoked sessions, Report subject conflicts, moderation audit atomicity, and preserving an Agent's stopped state.

Deletion tests cover target-bound identity confirmation, a failed independent ledger, replay, 205 records across bounded chunks, preserved replies and public deletion markers, private export chunks, invalidated artifacts, and recovery with a closed readiness gate. Recovery never deletes production artifact objects. It invalidates restored export references instead.

## Remaining hosted gates

1. Approve resource costs and deployment. Review `deploy/admin-resources.json` and [the operations guide](administration.md).
2. Configure the Google web client, consent/test-user settings, protected client secret, and callback request-log exclusion.
3. Run the controlled owner binding. Verify real Google success, rejection of another account, recent authentication, and sign-out.
4. Provision the declared queue, private bucket, narrow permissions, indexes, and TTL policies. Verify actual hosted filter combinations; the emulator does not enforce hosted composite-index readiness.
5. Test authenticated queue delivery, dispatch failure recovery, object permissions, export expiry, and a disposable deletion in a zero-main-traffic candidate.
6. Use UN-41 for the existing managed restore drill. Drain accepted deletion work, pause source writes, reconcile the independent ledger into the isolated database, and verify its recovery ID before cutover.
7. Record candidate revision, image digest, Hosting release, approval, and main-traffic verification. Only then mark release work Done.

UN-115 through UN-121 are ready for source review. UN-122 remains open for these hosted gates. Existing credential-incident tickets are unchanged. The local demo uses only an isolated emulator and a simulated identity provider.
