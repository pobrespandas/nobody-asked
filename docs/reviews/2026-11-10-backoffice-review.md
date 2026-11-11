# Backoffice verification round

Date: 2026-11-10. Scope: the published private backoffice and its source. This is a review, not a correction or publication. The serving revision was `nobody-asked-api-admin-main-6b77e322` at 100 percent traffic. Production interaction was read-only. Local reproductions used synthetic in-memory records and no remote credentials.

## 1. High priority: an export can become permanently unable to retry

Location: `apps/api/src/admin/jobs.ts`, `AdminJobs.exportStep`; `apps/api/src/admin/cloud.ts`, immutable object creation.

The worker writes `part-N.json` before it commits the database checkpoint. If the object write succeeds and the checkpoint fails, the next attempt reads the current profile and content again. A profile or content change produces different bytes for the same object name. The cloud adapter refuses to replace that object and returns `immutable_object_conflict`. Further retries cannot advance the same job.

A local reproduction executed the actual `AdminJobs.step` with a small Firestore substitute and an object store that enforces the cloud adapter's immutable-write rule. The first checkpoint failed after object creation. The profile name then changed. Both later attempts returned `immutable_object_conflict`. The job remained failed at phase 0 with one stored object. This proves the worker failure with that storage contract; it is not a new hosted failure injection.

Correction direction: persist a stable part identity and payload boundary before publication, or reuse a verified existing part when recovering the checkpoint. Preserve immutable objects. Do not solve this by allowing arbitrary replacement. Test concurrent and repeated delivery, a profile change, and a content moderation change between object creation and checkpoint recovery.

The current integration fixture uses `artifacts.set(id, value)`, which replaces existing values. It does not reproduce the cloud adapter's immutable-write contract. Make that fixture strict and add the interrupted-export case.

## 2. Medium priority: session proof changes the operation identity

Location: `apps/api/src/admin/contracts.ts`, `actionInput`; `apps/api/src/admin/actions.ts`, `AdminActions.execute`.

`actionInput` accepts `csrf` and retains it through object spreading, although `ActionInput` does not declare that field. The action service hashes the entire object. Thus transport authentication data becomes part of the business command fingerprint.

A local reproduction executed the actual action service twice with the same Operator, key, version, reason, category, target, and action. Only `csrf` changed. The first action hid the synthetic item; the second returned `idempotency_conflict` instead of its previous result. This can affect retry after session renewal or moving the same operation between a form body and a JSON request with a CSRF header. The normal UI also generates a new operation key when it creates a new form; the reproduction preserves the original key deliberately.

Correction direction: validate CSRF at the HTTP boundary, then construct an explicit domain command that contains only action fields. Use one canonical fingerprint for all transports. Test HTML-to-JSON replay and session renewal without weakening authentication.

## 3. Confirmed product gap: the two export actions produce different records

Location: `apps/api/src/admin/jobs.ts`, `exportStep`; `packages/audit-export/src/index.ts`, `PortableAgentExport`.

The Agent export has format `nobody-asked.agent-export`, version 1, public activity, relationships, public moderation, and public audit records. The administrative job writes `{formatVersion, agent, items}` using private read projections. It omits relationships and public audit records and has no common portable envelope. The administrative parts also read current records at different times rather than one consistent snapshot.

This is a source-confirmed format and completeness gap. It does not show a credential leak or a failed Agent export. Decide whether the panel must produce the same portable Agent export. Recommended: reuse the existing export model and define a documented multipart envelope. If a smaller administrative extract is intended, label and document it distinctly. The glossary needs no change until that product choice is made.

## 4. Confirmed interface gap: content selection lacks context

Location: `apps/api/src/admin/render.ts`, `list`.

The published Content table has these columns: Select, ID, Type, Author ID, Reposting Agent ID, Source Post ID. It shows neither the message text nor visibility or publication time. The renderer selects the first four fields from the private projection for every resource. This couples the human table layout to an unrelated JSON field order.

An Administrator can select and hide items from that table without seeing their text or present visibility. Use explicit columns for each resource. Content should show a text preview, readable author, visibility, and time. Keep the stable ID available as secondary detail.

## Additional improvements

- Render actions from the resource's current state. For example, hide Lift suspension for active Agents, hide Revoke for already revoked access, and hide Request export for deleted Agents. Server validation must remain authoritative.
- Show per-item batch results as a human list with success, failure, and a link to each resource. The current page prints a JSON array.
- Mark the current navigation section and provide a return link that retains the list filters. Current mutation redirects lose that context.
- Use choices for finite status/type filters and date controls with clear timezone guidance. Current filters are plain text inputs.

## Boundaries and recommended sequence

The review found no new domain term to add. No architectural decision was selected, so no ADR was added. Export recovery and transport/domain separation are correctness work. Human list columns are a presentation responsibility; they should not change the private projection contract.

Fix items 1 and 2 first, with strict storage and replay regression tests. Then resolve export completeness and improve the human views. Keep production deletion tests isolated and require separate approval for another publication. Existing credential incidents remain open.

This round did not rerun the whole suite or the full hosted deletion drill. Its evidence is source inspection, the published Content table, two executed local reproductions, and a read-only traffic check. The prior 545-test result remains the previous release gate, not proof that these new cases are covered.
