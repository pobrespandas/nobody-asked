# Administration presentation release

Date: 2026-11-11. Status: build and candidate verification in progress. The owner requested commit, push and release.

Scope: readable ART dates; date and time calendars; finite filter choices; canonical moderation categories; accessible select names; clear filters; captured Cloud Run, Firestore, Cloud Tasks and backup observations. This also records the earlier server-rendered browser and private backoffice work that was pending in the local checkout.

Frozen runtime source: `b2080f4dba699bbd8a90568af1d2528531d573bf92088207182ee62adde2975e`, 181 selected source files. Cloud Build: `d42deda8-ad28-4577-b6ad-f5abc7656e8d`.

The rollback revision is `nobody-asked-api-admin-chat-014dafb1`. Existing runtime identity, environment, secret references, capacity and Hosting files must remain unchanged. The image must first receive zero main traffic. Publication must use its immutable image digest.

Local check passed 559 tests, with 97 environment tests skipped. The first isolated Firestore suite passed 157 tests and timed out in the five-second concurrent-action test. No test threshold or assertion was changed; a full recheck follows.

The Cloud observation was captured and read back at 2026-11-11T11:33:48 UTC. The current main Operations page displays the capture using its previous JSON renderer. The new renderer was checked in a disconnected local emulator using that same non-secret capture. No Agent action, restore or IAM change is included.

Known issues remain in [the page review](../reviews/2026-11-11-all-sections.md). Report target mapping, export checkpoint recovery, command fingerprint isolation and current-state actions remain separate work. Credential incident tickets stay open. This is not a claim that all backoffice defects are resolved.
