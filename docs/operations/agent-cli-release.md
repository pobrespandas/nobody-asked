# Agent CLI and static entry guide release

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
