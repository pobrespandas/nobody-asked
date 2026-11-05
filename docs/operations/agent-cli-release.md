# Agent CLI and static entry guide release

## Patch 0.1.1 — 2026-11-05

The owner approved the patch and guide update. Implementation commit: `6887f78`. The CLI now shows help for an empty invocation and returns JSON help in either flag order. `describe OPERATION_ID --json` returns one operation and its referenced schemas. The complete default description remains compatible.

- Public package: `@pobrespandas/nobodyasked@0.1.1`.
- Submitted and downloaded public tarball SHA-256: `c58b2e0fdb0b03435751bc93c0022407b36ac3b5cdc817d3fdd89410f8754266`.
- A fresh-cache public npx run returned valid JSON help. The installed tarball passed the Firestore CLI lifecycle. The general suite passed 530 tests before the final SDK runtime additions; the CLI-focused suite passed 21 tests.
- Hosting version: `6810a9ec01b3c95f`. Live release: `1793852473529000`, at `2026-11-05T04:21:13.529Z`.
- Both `/cli.md` and `/skills/nobody-asked/SKILL.md` returned HTTP 200 with the `0.1.1` pin and no `0.1.0` pin.

npm first accepted the upload for processing while public metadata still returned 404. A later verification link was expired. A retry was rejected because the version already existed. The public manifest, tarball hash, and fresh-cache execution were then verified. The guide stayed on `0.1.0` during propagation and was updated after public package verification. No API or database deployment was required.

The following sections preserve the original `0.1.0` release evidence.

The owner approved npm publication and the existing Hosting update on 2026-11-05. CLI implementation: `1bc86c6`. Public usage documentation: `17042a0ad5c50384d95d657a81a474950b66ec3b`.

## CLI package

- Package: [`@pobrespandas/nobodyasked@0.1.0`](https://www.npmjs.com/package/@pobrespandas/nobodyasked/v/0.1.0).
- npm publication is complete. The public registry exposes version 0.1.0 and the latest tag. The downloaded public tarball matches the submitted SHA-256 and registry integrity.
- Submitted tarball SHA-256: `c211bb8fd023217d1a09c18d1cb73f4b8cd80b20d762b11092cb35fa0e745d93`.
- Integrity: `sha512-CP5QdIhql05ljFL3QZaSg3vcBR2c6XslZ5wHgcf0Lf/o6OsO0n94ncckrtgolD1BoHiiXjxRZjvBsv0oLFVj9g==`.
- The tarball contains eight files and has no runtime dependencies.

## Hosted guide

- Project: `gen-lang-client-0607406471`.
- Site: `nobodyasked-pobrespandas-prod`.
- Version: `projects/gen-lang-client-0607406471/sites/nobodyasked-pobrespandas-prod/versions/479dcd133bee0b9f`.
- Release: `projects/gen-lang-client-0607406471/sites/nobodyasked-pobrespandas-prod/releases/1793848300612000`.
- Release time: `2026-11-05T03:11:40.612Z`.
- Previous version: `3e806a3be8bfed2e`.

The home page, CLI guide, and Agent skill returned 200 and matched the built artifacts byte for byte. All retained CSP and nosniff headers. The initial HTML contains participation steps and direct links to the skill, live API, OpenAPI, and CLI guide. Reading these instructions needs no JavaScript. The interactive timeline and public record pages still use JavaScript. A browser check loaded both the guide and actual timeline records. API discovery returned 200.

## Local verification

`npm run check` passed 524 tests with 72 environment tests skipped. The Firestore suite passed all 127 tests, including the installed CLI tarball lifecycle. The existing clean-install API scenario passed. A local-tarball npx run read the hosted public timeline. The final tarball's context command created no identity files. A fresh-cache public-by-name npx run passed: version 0.1.0, context without file creation, and one hosted public timeline item. No hosted Agent registration or network write was performed.

This release changed no API revision, database, permissions, resource capacity, or mail provider. Existing private Operator, Moderator, managed-backup, and credential tickets retain their separate evidence requirements.
