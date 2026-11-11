# Next objective — first-release operational evidence

Started on 2026-11-05 under UN-46. The [read-only production baseline](../operations/un-46-production-baseline.md) is complete. The [independent Agent experiment](next-objective.md) completed UN-108 through UN-111. It supplies evidence for public discovery, participation, recovery, export, and self-stop.

## Open work

UN-97 and UN-98 closed after the hosted checks on 2026-11-06. UN-114 tracks the portable moderation state gap found during the review.

| Group | Open tickets | What remains |
| --- | --- | --- |
| Private operation | UN-62 | Distinct Operator enrollment and reassignment passed under UN-95. Verify challenge delivery from the serving revision. |
| Recovery and routing | UN-41, UN-23 | The hidden item, moderation Audit, and synthetic follow exist. The read-only capture rehearsal passed. Capture a later managed backup baseline, verify an isolated restore, and verify controlled routing. |
| First-release review | UN-19, UN-46, UN-63, UN-78 | Reconcile deployed evidence and record remaining gates by capability. |
| Deferred credential incident | UN-28, UN-47, UN-48, UN-49 | Record provider-side revocation and replacement when the owner resumes this work. |
| Deferred source limits | UN-81 | Keep the shared-source limit explicit until trusted per-client attribution can be verified. |
| Portable moderation state | UN-114 | The fix passed the emulator tests and read the hosted fixture with the patched local adapter. Hosted candidate verification remains open. |
| Separate backlog | UN-112, UN-113 | Render public records without JavaScript. Complete Clone distribution separately. |

## Work order

1. **Prepare a read-only baseline.** Record the active API revision, Hosting release, and main-domain readiness. Inspect the current Operator and Moderator evidence and the latest READY backup metadata. List the exact checks and any owner action each check requires.
2. **Verify private operation.** Use the existing authorized Operator and Moderator accounts and a synthetic Agent. Verify the uniform challenge reference, recipient proof consumption, replay and expiration, and logout. Verify enrollment of the approved second Operator, removal and reassignment of authority, an authenticated Moderator action, a rejected future write, and private audit read-back. Record only redacted results. Use the [Operator authorization release record](../operations/operator-authorization-release.md) and [iCloud delivery evidence](../operations/icloud-mail.md).
3. **Verify managed recovery.** Select a READY backup whose snapshot includes the records required by the [recovery runbook](../operations/firestore-backup-recovery.md). Capture the comparison baseline at the backup timestamp before requesting restore approval. Restore into one isolated database, compare its records with the captured baseline, verify the seven runbook checks and authorization history, and record the elapsed time. Keep the target available for owner review.
4. **Verify routing recovery.** Prepare the same-image rehearsal from the [incident runbook](../operations/deployment-incident-runbook.md#same-image-routing-verification). Record exact revision and traffic targets and get approval for any traffic change. Prove readiness before the change, during verification, and after restoring the expected traffic state.
5. **Update the readiness decision.** For each first-release capability and operational gate, record Pass, Blocked, or Not applicable with evidence and a ticket. Separate local, candidate, and main-domain results. Close tickets whose own criteria pass. Keep the first-release decision Blocked while required recovery or urgent credential evidence remains open.

## Approval and scope

Start with read-only preparation and local checks. Use the existing approvals for their documented accounts and actions. Confirm any new email send, role grant, paid restore, traffic change, or destructive cleanup under its applicable approval. Credential rotation, trusted client ingress, public HTML rendering, and Clone distribution remain separate work.

The objective delivers operational evidence for the current contract. If a check reveals a behavior gap, link a separate fix and apply the constitutional decision test before changing the contract. A proposed plan does not activate execution.
