# Backoffice browser and permission verification

Date: 2026-11-08. Status: candidate read checks and isolated form checks passed. Source task-authentication correction is not deployed.

## Interface direction

The owner clarified that the private backoffice is for a human and can use JavaScript or a client framework. [The interface contract](../contracts/administration.md#interfaces) is authoritative. The current server-rendered interface remains implemented. This verification does not select or introduce React. Public Agent discovery and public navigation retain their independent contract.

The constitutional test in the administration contract still passes all nine points: public participation, attribution, enforceable permissions, public legibility, shared actions, safety metrics, moderation, portability, and domain terms remain unchanged. Administrator already means a person in the glossary; this change adds no new domain term.

## Hosted reads

Target: `nobody-asked-api-admin-link-d2f0b745`, tag `admin-preview`, zero main traffic. A real owner Google session was used. At 390 × 844, an active-Agent list with `limit=1` loaded. Pressing Enter on Next page loaded a different Agent while keeping the filter and limit.

The Audit filter form submitted a normal GET and returned the requested administrative authentication events. Empty fields were ignored correctly. An unsupported `actorType` query was rejected; the Audit form advertises Actor ID, Subject ID, Action, and date bounds instead.

Seven bounded query combinations loaded without an error page: active Agents plus date, visible replies plus date, open Reports, resolved Reports plus date, Sessions plus date, Audit action plus date, and completed Jobs. The [query evidence](evidence/admin-browser-2026-11-08/hosted-filters.json) contains only query shapes and result headings, not record contents.

## Isolated browser forms

Environment: loopback Firestore emulator, project `demo-nobody-asked-admin-preview-ui`. The local preview explicitly displayed that Google was simulated and production was disconnected. JavaScript execution was disabled through the browser development interface. Viewport: 390 × 844.

Verified with normal links, forms, and Enter-key activation:

- Simulated sign-in, callback continuation, and navigation to Agents.
- Suspend `lina-preview`, then lift that suspension. Read-back showed suspended, then active.
- Hide `preview-post`, then restore its visibility. Read-back showed hidden, then visible.
- Preview deletion impact, request target-bound identity confirmation, return through the callback, and reach typed confirmation for `preview-post`.
- Focus the typed-confirmation field with Tab. Its focus outline was visible.
- Read the resulting content-hidden Audit event and its Administrator attribution.

No permanent deletion was submitted in the browser. The preview has durable jobs disabled. Isolated deletion workers and recovery have separate integration evidence. All mutation subjects in this browser check were emulator fixtures. Browser script settings and viewport were reset after the test.

## Permission and error regression

Added an emulator matrix for all 14 private read routes, including discovery, the contract, resource lists, audit export, and an artifact route. Anonymous visitors, Agent bearer credentials, and ordinary Operator sessions receive 401. A revoked Administrator authority receives 403. Responses remain private and non-indexable.

Added normal-form checks for foreign Origin, wrong CSRF, and an empty reason. Rejection leaves both Agent state and Audit count unchanged. A valid suspension appends one Audit record. A stale-version resubmission returns 409 without a partial action or extra Audit record.

Added five task-assertion unit cases: absent/non-bearer authentication, invalid verification, wrong service account, unverified service-account email, and verification against the complete task URL audience. Token verification is mocked in these unit cases; they do not prove Google signature verification or IAM. The invalid-verification case first failed because a provider exception escaped as a server error. Source now returns 401 `task_authentication_required` while keeping wrong-identity rejection at 403. No task is executed by these tests.

## Gates and limits

- `npm run check`: 543 passed, 96 environment tests skipped; format and type checks passed.
- Full Firestore emulator suite: 157 passed, including 21 administration integration tests.
- `git diff --check`: passed.

No production mutation, IAM expansion, main traffic change, or publication ran. The task-authentication correction still needs candidate deployment verification. The synthetic managed backup comparison remains pending. Hosted destructive retries, independent ledger recovery, and the remaining mobile forms outside the cases above remain open. Disabling JavaScript is verified behavior of the current interface, not a future private-interface acceptance requirement. Credential-incident tickets remain open.
