# Exposed development secret rotation

Use this runbook for `CURSOR_API_KEY`, `GEMINI_API_KEY`, and `TELEGRAM_BOT_TOKEN`. A Firebase CLI debug log received these variables from a local process environment. Treat all three values as compromised.

## Local evidence

Audit date: 2026-11-01.

The audit inspected names, paths, and presence states only. It did not print, copy, compare, measure, or hash a secret value.

| Check | Result |
| --- | --- |
| Current process environment | All three variable names are present. Their values were not read or used. |
| Working tree before this runbook | Clean. |
| Original `firebase-debug.log` | Absent from the working tree and ignored-file list. |
| Tracked debug logs | None. |
| Debug-log paths in Git history | None. |
| Variable names in Git history | Only `packages/firestore-support/src/admin.test.ts`. This test proves that unrelated variables do not enter the Firebase CLI process. |
| Provider token patterns in Git history | No Gemini or Telegram token pattern match. Cursor has no documented stable token pattern, so its history check used the variable name only. |
| Current ignored logs | `firestore-debug.log` exists from the emulator test. It contains none of the three variable names. It is not the deleted Firebase CLI debug log. |
| Current ignored browser artifact | `dist/browser/` exists. It contains none of the three variable names and no reviewed Gemini or Telegram token pattern. |
| Firebase local artifact | `.firebase/` is absent. |
| CI configuration | No reference to the three variables. No artifact upload or download action. |
| Repository consumers | No product consumer. The only name references are the environment-sanitization test. |

The deleted untracked log is not recoverable through Git. This audit cannot inspect a filesystem backup, terminal scrollback, provider access log, external CI system, or a copy made before deletion. Absence is not proof of secrecy. Rotation is still required.

## Common sequence

1. Open the provider in a trusted browser session. Confirm the account, team, project, or bot by its non-secret identifier.
2. Revoke the exposed credential before you create or enable a replacement. A short outage is safer than overlap with a compromised credential.
3. Create one replacement with the minimum supported authority.
4. Put the replacement directly into the approved secret store through its secure input channel.
5. Update each authorized consumer to reference the replacement. No current consumer exists in this repository. Identify the external consumer before this step.
6. Verify the replacement through the normal consumer. Record only the provider resource ID, consumer name, UTC time, result, and non-secret audit event.
7. Confirm in the provider console that the exposed credential is revoked or deleted.
8. Confirm that logs, shell history, issue comments, Clone records, build artifacts, and Git contain no credential value.

Completion requires provider-side revocation evidence, one authorized replacement consumer, a successful verification, and a second repository audit with the same value-safe method.

Safe stop: keep the affected consumer disabled when the target account is uncertain, the exposed credential cannot be identified without comparing secret values, the replacement destination is unknown, or verification would put a credential in a URL, command argument, log, or issue.

## Cursor

First identify the credential type from non-secret dashboard metadata.

The replacement must use the same approved consumer boundary. Prefer a service account key for automation.

### Service account API key

1. Open **Cursor Dashboard → Settings → API Keys → Service Accounts**.
2. Select the service account used by the external consumer.
3. Use its rotate action. Cursor invalidates the old key immediately and shows the new key once.
4. Send the new key directly to the approved secret store.
5. Restart or redeploy the authorized consumer.
6. Verify the consumer identity and one low-impact operation. Record no prompt, response body, authorization header, or key fragment.
7. Confirm the rotation event and active service account in Cursor.

### Personal API key

1. Open the Cursor API Keys dashboard. An Enterprise team administrator can open the member key list from **API Keys → Members**.
2. Revoke the exposed personal key, or revoke all keys for that member when the key cannot be identified by non-secret metadata.
3. Create a new personal key only when policy permits it and the consumer cannot use a service account.
4. Send the new key directly to the approved secret store and update the external consumer.
5. Verify authentication with the normal consumer. `cursor-agent status` can confirm the authenticated account when the consumer is Cursor CLI.
6. Confirm the `user_api_key` revoke event in the Cursor audit log when the plan exposes it.

Safe stop: revoke all candidate keys and keep the automation off when the dashboard cannot distinguish the exposed key without revealing or comparing key material. Do not use `--api-key` because command arguments can enter process inspection and shell history.

Official references: [Cursor service accounts](https://cursor.com/docs/account/enterprise/service-accounts), [Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication), and [Cursor member API key revocation](https://cursor.com/docs/account/teams/members).

## Gemini

1. Open Google AI Studio **API Keys**, or the Google Cloud **Credentials** page for the confirmed project.
2. Identify the exposed key by its non-secret key ID, display name, project, and restrictions. Do not compare key strings.
3. Delete the exposed key. For a compromised key, do not keep the old and new keys active for a normal overlap period.
4. Create the replacement in the same confirmed project. Prefer the current Gemini authorization-key flow when the project policy supports it. Otherwise create a standard key restricted to the Generative Language API and the required application boundary.
5. Put the replacement directly into the approved secret store as `GEMINI_API_KEY`. Update only the identified external consumer.
6. Verify one low-impact Gemini operation through that consumer. Send the key through the client library or `x-goog-api-key` header boundary. Keep it out of URLs and logs.
7. Confirm that the old key has deleted status and that usage moves to the replacement key ID.

Google permits restoration of a deleted API key for 30 days. Treat deletion status as the revocation control and do not restore the exposed key.

Safe stop: keep Gemini access disabled when the Google Cloud project, key ID, API restriction, service account binding, billing account, or replacement consumer is uncertain. Do not create an unrestricted replacement.

Official references: [Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key), [Google Cloud API key rotation](https://docs.cloud.google.com/docs/authentication/api-keys), and [API key security practices](https://docs.cloud.google.com/docs/authentication/api-keys-best-practices).

## Telegram

1. Open the verified `@BotFather` account in a trusted Telegram session.
2. Use `/mybots`, select the confirmed bot, open **API Token**, and revoke the current token. Telegram states that a bot token can be revoked through `@BotFather`.
3. Generate the replacement token for the same bot.
4. Put the replacement directly into the approved secret store as `TELEGRAM_BOT_TOKEN`. Update only the identified bot consumer.
5. Restart or redeploy the consumer. Verify the bot identity and one controlled message through the normal application path.
6. Confirm that the old token is revoked in `@BotFather` and that only the intended consumer resumes updates.

The Telegram Bot API places the token in the request URL. Do not run a manual `curl` verification because URLs can enter shell history, proxies, and logs. Use the configured consumer with redacted transport logs.

Safe stop: keep the bot consumer stopped when the bot identity, owning Telegram account, webhook target, polling process, or secret-store destination is uncertain. Revoke the token and investigate before you resume updates.

Official reference: [Telegram bot tutorial and token revocation](https://core.telegram.org/bots/tutorial).

## Evidence record

For each issue, record only this checklist:

- Provider resource: non-secret account, project, service account, key ID, or bot handle.
- Revocation: confirmed, with UTC time and provider audit event when available.
- Replacement: stored in the approved secret store; record the secret resource name or version, not its value.
- Consumer: exact external service or workstation updated.
- Verification: operation name, UTC time, status, and expected identity.
- Audit: repository, log, artifact, and CI checks passed without a value match.

Keep UN-28, UN-47, UN-48, and UN-49 open until a person with each provider session completes and records this evidence.
