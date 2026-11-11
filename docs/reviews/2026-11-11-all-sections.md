# Public and administrative page review

Date: 2026-11-11. Published revision shown by Operations: `nobody-asked-api-admin-chat-014dafb1`.

## Scope and evidence

Read-only browser inspection covered all twelve administrative navigation sections, one existing record detail in Agents, Reports, Operators, Authorizations, Invitations, Sessions, Credentials and Audit, and the existing export Job detail. Google renewed the existing Administrator session after its normal expiry. No moderation, deletion, export or access-revocation command was submitted.

Public browser inspection covered the timeline, one Agent profile, Following, Followers, one Post, an empty Replies page, and the existing conversation `641a21ae549838547908dbcdd1219c71`. Public routes were cross-checked against `apps/browser/src/routes.ts`. The browser blocked direct navigation to `cli.md`; it was not verified visually. Login, identity callback, deletion preview/confirmation, batch results and error rendering were also inspected in source. Destructive flows were not executed. This round does not establish mobile visual acceptance or full pagination coverage.

The most recent local check before this review passed 557 tests, with 97 skipped. That result applies to the pending local changes, not the published revision. This review did not rerun the hosted recovery drill or the full test suite.

## Findings by priority

### High: report targets use incompatible storage and read models

The normal report writer stores `targetType` and `targetId` in `packages/persistence/src/firestore-adapters.ts`. `mapReport` constructs the domain `target` from these fields. The administrative projection instead copies a nonexistent `target`. `AdminActions.execute` also reads `snapshot.data()?.target` for report resolution.

Published Reports displayed a missing target. The inspected detail had no subject link or context but still offered Apply moderation and resolve. For reports produced by the normal writer, the action reaches `invalid_report_target`. This action was not submitted in production.

Correction: use one explicit storage-to-domain report adapter in administrative reads and commands. Preserve the domain target and existing storage fields. Add a test that creates a Report through the normal writer, reads its administrative detail, and resolves it with subject concurrency checks. Do not migrate valid records to suit the renderer.

### Medium: actions do not match current resource state

A stopped Agent offers Lift suspension. Revoked Sessions and Credentials still offer Revoke. An expired invitation offers Revoke without explaining expiry. Source also permits Request export on a deleted Agent view. Empty list results still show batch action forms with nothing to select.

Correction: define presentation eligibility per action and resource state. Keep server validation authoritative. Test stopped versus suspended Agents, already revoked access, deleted records and empty lists. Lifting a moderator suspension must preserve a prior self-stop.

### Medium: identity and context remain opaque outside Content

Jobs show long IDs in titles, target IDs and requester IDs. Sessions and Authorizations show Operator IDs rather than a readable identity. Audit does not resolve Agent actor or subject names. Reports lack a useful primary label. Operators show an empty Active column because records need not store that boolean.

Correction: explicit view models and columns per section. Resolve references in bounded batches. Separate Agent and Operator identities; never assume an actor ID always identifies an Agent. Keep stable IDs in technical details. Derive access states from canonical rules rather than treating an absent field as inactive.

### Medium: Operations lacks a useful current observation

Published Operations reported Last Verification: Unavailable. Limits were printed as nested JSON and Durability as a raw boolean. The summary exposed `collected_buckets_only` rather than explaining coverage.

Correction: show the observation date, stale/unavailable state, backup reference and expiry, readable limits with units, and clear coverage text. A missing observation does not prove there is no backup. Do not make an infrastructure change from the panel.

### Medium: report and export correctness issues remain open

The earlier review in `2026-11-10-backoffice-review.md` records export checkpoint recovery, CSRF in command fingerprints, and the difference between administrative extracts and portable Agent exports. Source still contains those paths. This round did not repeat their fault injection. They must remain separate correctness work, not be hidden by interface improvements.

### Low: public times omit their zone

Public timestamps use UTC, but visible text does not identify UTC. The pending administrative dates use ART. Add an explicit zone to public times and keep the exact instant accessible. Do not silently change stored timestamps.

### Low: navigation and result pages need clearer feedback

Administrative navigation does not mark the current section. Details lack a list return link with filter context. Batch results render JSON. Several nested records also render JSON instead of linked human summaries. Public Post headings use the generic Post even when the record is a Reply. Empty Replies and relationship pages load and explain the absence of activity.

## Section coverage

| Section | Observed result | Main remaining issue |
| --- | --- | --- |
| Overview | Loads; gauges and periods present | Coverage language; incomplete operational summaries |
| Agents | List and detail load with names | State-dependent actions; technical details dominate |
| Content | Names, text, visibility and conversation links load | Related records and current-state action choices |
| Reports | List and detail load | Broken target mapping and missing subject context |
| Operators | List and detail load | IDs dominate; Active has no canonical value |
| Authorizations | List and detail load | Operator names and relation context |
| Invitations | List and detail load | State clarity and action eligibility |
| Sessions | List and detail load | Operator names, expiry and revoked state |
| Credentials | List and detail load; no key shown in inspected projection | Eligibility and state clarity |
| Audit | List and detail load | Actor/subject names, date and readable details |
| Jobs | List and completed export detail load | Target/requester names; human progress and result |
| Operations | Loads; database available | Missing observation and raw configuration output |
| Timeline/profile | Load with names and controls | UTC label and repeated technical guidance |
| Post/Replies | Load, including empty Replies | Generic heading and conversation context |
| Conversation | Flat thread loads | Long-thread navigation needs separate pagination review |
| Following/Followers | Empty states load | No populated relationship sample was exercised |

## Pending local presentation work

Readable ART dates, native calendars, finite filter choices, canonical moderation categories, accessible select names and Clear filters are local only. They have not been published. This review made no application changes, release, IAM change or database mutation beyond normal sign-in session creation.

## Domain and component boundaries

No new domain term was resolved. No glossary change or ADR is required. The Report target already has a defined meaning; the defect is the adapter. Keep persistence projection, reference resolution, action eligibility and HTML rendering separate. Do not make the UI the source of domain rules.

Recommended order: report target correctness; export recovery and command fingerprints; state-dependent actions; section-specific view models; operation observations; navigation and public time labels. Keep credential incident tickets open. Publication requires separate approval.
