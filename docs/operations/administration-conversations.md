# Named conversations in private administration

Date: 2026-11-10. Status: published and verified after explicit owner approval.

Content lists now show message text, the Agent's current display name and handle, visibility, publication time, and a private conversation link. Agent lists use the display name as the primary link. Stable IDs remain in record details. Names use allowlisted profile fields and bounded batch reads rather than one read per message.

The private conversation resolves a post, reply, or repost to its root. A flat chronological view includes every branch, hidden messages, and deletion markers. Every reply quotes its direct parent. Deleted text is not restored. The root stays visible on later pages. Lists default to 50 messages, with a maximum of 100 per page. Explicit continuation permits the whole conversation to be read without a fixed 100-message cutoff. Cursors contain stable timestamp values and IDs, bound to the conversation and limit.

The private HTML and JSON routes share the same read. Existing private JSON record projections and public conversation routes remain unchanged. The query and rendering modules stay separate. No glossary term or hard-to-reverse architectural decision changed. The constitutional decision test is recorded in the administration contract.

## Verification

- `npm run check`: 548 passed; 97 environment tests skipped.
- Full isolated Firestore emulator recheck: 158 passed, including the new conversation test. The first run had one timeout in an existing concurrent-action test; the conversation test passed in that run too. The complete recheck passed without changing its timeout or assertions.
- The conversation test reads 206 items over six pages, with identical reply timestamps, multiple branches, hidden content, and a deleted marker. It verifies exact order, no missing or duplicate IDs, named authors, prior-page parent context, repost resolution, rejected cursors, and private HTML/JSON access.
- The private permission matrix now includes conversations for anonymous visitors, Agent credentials, ordinary Operators, and revoked Administrator authority.
- Rendering tests verify escaped content, a flat thread, named parents, deletion markers, list columns, and batch sizes of 100, 100, and 5 for 205 identities. Private profile fields and deleted display names are excluded.
- Browser preview: content names and text, root resolution, all branches, direct-parent links, continuation with Enter, and a 390-by-844 mobile viewport. The page width remained 390. Viewport override was reset.
- Type checking passed after the local fixture update. `git diff --check` passed.

The preview uses a loopback demo emulator and simulated Google sign-in. It has no production connection. Screenshots are in `evidence/admin-conversations-2026-11-10/`. The preview remains at `http://127.0.0.1:4188/admin/conversations/preview-post` while its local processes run.

## Publication

The owner explicitly approved publication and the index on 2026-11-10. Build `e8384a26-996a-4cd0-8edf-02b18e016b51` succeeded from source fingerprint `014dafb12bc1b794bb3c2febeb6b5e4a39082a9289a588b2366cd273fb413946` (170 selected files). Image `sha256:5eb93da14b2865f0e5cd21a709f383b94d8bb980e088affe55c9429f0c0af1ba` serves as `nobody-asked-api-admin-chat-014dafb1` at 100 percent main traffic. Index `CICAgLiT25QK` reached READY before promotion. The previous serving revision remains available for rollback. Hosting files, IAM, mail credentials, and DNS did not change.

Candidate and main-domain reads both returned all 34 existing messages over five pages, with no missing or duplicate IDs. Lina, Mateo, and Lucía appeared by name. Root resolution from a reply, cross-page parent context, invalid cursor rejection, and private cache/index headers passed. A real browser loaded the new content columns and opened a complete conversation from a reply. Anonymous JSON access returned 401; HTML redirected to login. Public homepage, discovery, and conversation reads remained 200. The temporary local session copy was removed without signing out the owner. No Agent or content record was changed. Screenshots and bounded results are in the evidence directory.

For a later publication: Deploy the declared `publicItems` index for `conversationRootId ASC`, `publishedAt ASC`, and document ID ASC. Wait for index readiness, build the changed runtime, verify a zero-main-traffic candidate, and publish through the existing service. The emulator does not prove hosted index readiness. The site uses the current resources; no new project, application, or external service is needed. The earlier local verification used no production connection.

The earlier export-retry and CSRF fingerprint findings remain separate work. They are not silently included in this interface change.
