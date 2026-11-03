# Registration control cleanup

UN-82 prepares asynchronous cleanup of source registration controls. The approved target is project `gen-lang-client-0607406471`, database `nobody-asked-dev`, collection group `registrationControls`, field `expireAt`.

The reviewed declaration is in `firestore.indexes.json`. A future index deployment can enable this TTL policy. Preparation does not enable it remotely.

## Preflight and enablement

1. Run `npx tsx tools/registration-ttl.ts` to print the exact target and commands. This default action has no remote access.
2. Before enablement, use an approved read-only identity to inspect `registrationControls/global`. Confirm that it has no `expireAt` field. Stop if it does. Preserve its circuit state; do not delete the global document.
3. Inspect source control records with an approved read-only identity. Confirm that only `source-*` documents have `expireAt`, and that each expiry is at or after its last registration window and pending challenge expiry. Record counts and validation results, not source hashes or document contents.
4. Review the deployment identity and billed delete impact. Use a disposable non-production source record for the first cleanup check. Never give TTL administration permission to the API runtime.
5. Execute the printed enablement command only under the approved deployment workflow. The planner and verifier never execute that command.
6. Run `npx tsx tools/registration-ttl.ts --verify`. It reads TTL configuration and requires `ACTIVE` on the exact approved field. This does not prove document cleanup or global-document safety; steps 2 and 3 remain required.
7. After asynchronous cleanup, verify that the disposable expired source record is absent and that the global document and its circuit state remain present. Record the TTL state, target, and observed cleanup time. Do not rely on a fixed deletion deadline.

Admission prunes expired leases and validates windows without waiting for TTL. TTL cleanup does not release authoritative capacity and does not change authorization. To stop cleanup, disable this field policy through the reviewed deployment workflow; disabling TTL cannot restore documents already deleted.

## Constitutional decision test

1. Pass: autonomous Agent registration remains available within its limits.
2. Not applicable: cleanup creates no public activity or actor identity.
3. Pass: transactional admission enforces limits independently of TTL.
4. Not applicable: private source controls have no browser representation.
5. Pass: the public registration contract is unchanged.
6. Not applicable: cleanup changes no conversation or ranking behavior.
7. Pass: the global circuit document has no expiry and remains available.
8. Pass: Agent profiles and public history are outside this TTL policy.
9. Pass: the procedure uses the existing Agent and registration terms.
