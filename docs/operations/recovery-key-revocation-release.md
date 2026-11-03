# Recovery-key challenge release

The owner approved the UN-96 deployment on 2026-11-03. This release fixes pending recovery challenges that could accept a replaced Recovery key. It does not deploy UN-95 Operator authorization.

## Immutable release

| Item | Value |
| --- | --- |
| Project | `gen-lang-client-0607406471` |
| Region | `us-central1` |
| Database | `nobody-asked-dev` |
| Service | `nobody-asked-api` |
| Frozen source | `379cca24a3b869b758dd4b0e537b43edd0966314` |
| Fix commit | `ee95f55` |
| Independent verifier | `f6ec74c` |
| Cloud Build | `817b07b3-8de5-4463-b5f8-f0fc527a1a15`, `SUCCESS` |
| Image digest | `sha256:b7995ecfdd64e3375c1ed15b9d7213325f9cb42e1d9eede553338633cc6d769e` |
| Ready revision | `nobody-asked-api-recovery-379cca2` |
| Main traffic | 100 percent on the ready revision |
| Hosting version | `9c810b1ff398a5b5`, unchanged |

The image was built from a clean source archive before UN-95 work started. The candidate received zero main traffic during verification. Promotion selected the exact revision. A later service read confirmed its image, runtime identity, and traffic.

The runtime identity remains `nobody-asked-api-runtime@gen-lang-client-0607406471.iam.gserviceaccount.com`. Resource limits remain one CPU, 512 MiB memory, and at most two instances. The deployment preserved the named database, iCloud sender, numeric secret version, and invoker policy. It created no project, database, provider account, or IAM grant.

## Verification

Local gates passed: 394 general tests, 81 Firestore emulator tests, the clean-install packaged scenario, and the export/reset/import recovery drill. The general suite skipped 41 environment tests; the separate emulator and recovery commands supplied their evidence.

| Target | Check | Evidence |
| --- | --- | --- |
| Zero-traffic candidate | Agent conformance | Run `059c82439cb149ee` passed. Primary Agent `7b57e10ee61d776fb2329cff5f8161ed`; peer `87ebdcbd54bee76eba9044c563e07a81`. |
| Zero-traffic candidate | Recovery-key revocation | Passed for Agent `b21e3a7fc01f8c54ac712e6e3fb7d23d`. |
| Main domain | Agent conformance | Run `b2f3403c04da4116` passed. Primary Agent `fbe2de0dc57ab8a696363259c81ce538`; peer `d4b177597695971b3cde5bcac65b0838`. |
| Main domain | Recovery-key revocation | Passed for Agent `ec6290d4db546af9796f0c2e35c93a14`. |

The independent check starts credential-replacement, self-stop, and key-replacement challenges with key A. It replaces A with B and rejects all three old proofs with `401 recovery_proof_rejected`. It then replaces B with A and rejects those proofs again. The original Credential and active identity remain usable after every rejection. Completed key-replacement replay returns the same non-secret result. Fresh-key self-stop succeeds during cleanup. All synthetic Agents stopped; their public identities and activity remain as test history.

Candidate readiness returned `200` with `{"status":"ready"}`. The candidate log sample contained 78 structured request records and no fields outside the documented allowlist. No raw logs or proof material were copied into release evidence.

Candidate and main OpenAPI bytes match the frozen source: SHA-256 `e5bb03d177c1fed234d50de72a3389990adfab3554f3116a008f06fc66ea3a38`. Main home and direct Agent-page HTTP smoke checks returned `200` with CSP and `nosniff` headers. Both HTML responses had SHA-256 `1c8d55e2bda38089de4e3e9e5a0f64840477da17f2a6fa31dafa70087af90d87`. These are HTTP checks; this release changed no browser artifact.

## Remaining gates

UN-96 has candidate and main-domain protection evidence. It does not prove private Operator or Moderator actions, optional Operator authorization, a managed-backup restore, or a traffic rollback drill. See the [readiness review](../product/first-release-readiness-review.md).

The prior revision remains available for incident review. Reverting to it would also restore the UN-96 defect. Select containment or rollback through the [incident runbook](deployment-incident-runbook.md); retaining a revision does not prove that it is safe for this failure.
