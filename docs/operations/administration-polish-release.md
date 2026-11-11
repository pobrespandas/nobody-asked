# Administration presentation release

Date: 2026-11-11. Status: candidate verified; pull request review and main publication pending. The owner requested commit, push and release.

Scope: readable ART dates; date and time calendars; finite filter choices; canonical moderation categories; accessible select names; clear filters; captured Cloud Run, Firestore, Cloud Tasks and backup observations. This also records the earlier server-rendered browser and private backoffice work that was pending in the local checkout.

Frozen runtime source: `b2080f4dba699bbd8a90568af1d2528531d573bf92088207182ee62adde2975e`, 181 selected source files. Cloud Build: `d42deda8-ad28-4577-b6ad-f5abc7656e8d`.

The rollback revision is `nobody-asked-api-admin-chat-014dafb1`. Existing runtime identity, environment, secret references, capacity and Hosting files must remain unchanged. The image must first receive zero main traffic. Publication must use its immutable image digest.

Local check passed 559 tests, with 97 environment tests skipped. The first isolated Firestore suite passed 157 tests and timed out in the five-second concurrent-action test. No test threshold or assertion was changed; a full recheck follows.

The Cloud observation was captured and read back at 2026-11-11T11:33:48 UTC. The current main Operations page displays the capture using its previous JSON renderer. The new renderer was checked in a disconnected local emulator using that same non-secret capture. No Agent action, restore or IAM change is included.

Known issues remain in [the page review](../reviews/2026-11-11-all-sections.md). Report target mapping, export checkpoint recovery, command fingerprint isolation and current-state actions remain separate work. Credential incident tickets stay open. This is not a claim that all backoffice defects are resolved.

## Candidate result

Cloud Build succeeded. Image: `us-central1-docker.pkg.dev/gen-lang-client-0607406471/nobody-asked/api@sha256:cfb2f7da8ae351c94e48cb7eb0aee50006339478898812c0310d94f9fa14f1bc`. Candidate revision: `nobody-asked-api-admin-polish-b2080f4d`. It receives zero main traffic through the existing `admin-release` tag. Main traffic remains on the rollback revision.

The full isolated Firestore recheck passed all 158 tests. The installed-package scenario passed all discovered public operations and stopped its synthetic Agents. Authenticated candidate reads passed for Agents, Content, Operations and the complete existing conversation. Anonymous administrative JSON returned 401. Private responses used no-store and noindex headers. Readiness, public homepage and discovery returned 200. Configuration comparison preserved the runtime service account, environment, secret references, CPU/memory, ports, concurrency, timeout and maximum instances.

Source commit: `901596c`. Pull request: https://github.com/pobrespandas/nobody-asked/pull/4. GitHub rejected a direct main push because main requires a pull request, one approving review and the verification check. The release uses that process without bypassing protection. Evidence is in `evidence/admin-polish-2026-11-11/`. No main-traffic promotion or Hosting publication has occurred.
