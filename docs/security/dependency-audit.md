# Dependency audit

## 2026-11-01

The repository overrides `@grpc/grpc-js` to `1.14.7`.

`@firebase/rules-unit-testing` 5.0.0 installs Firebase 12.19.0 and Firestore 4.17.2. Its default tree selected `@grpc/grpc-js` 1.9.16. That version has high-severity advisories. Firebase Admin already selected `@grpc/grpc-js` 1.14.7. The root override makes both paths use 1.14.7.

Verification requirements:

- `npm ls @grpc/grpc-js --all` must show only 1.14.7 or a later reviewed version.
- `npm audit` must show no high or critical vulnerability from `@grpc/grpc-js`.
- The full check and the real Firestore emulator suite must pass after an override change.

### Remaining moderate findings

`npm audit` reports 16 moderate dependency findings and no high or critical finding. `npm audit --omit=dev` reports six of those dependency nodes. They enter through the current Firebase Admin Firestore client and its generated API client. The advisories concern file matching and cleanup utilities used by the client toolchain. They are transitive; the application does not call those utilities with user input. Keep them open for a compatible Firebase Admin or Firestore client update. Do not describe them as development-only.

The other ten reported dependency nodes enter through `firebase-tools` 15.34.2. This is the current published Firebase Tools version. It is a root development dependency used to start the local emulator. It is not imported by the API, browser, persistence adapter, or hosted runtime.

The Firebase Tools paths include development tooling for archives, file matching, HTTP metadata, Pub/Sub support, static serving, telemetry, and UUID utilities. npm proposes `firebase-tools` 3.18.2 as the automatic resolution. That is a large downgrade from the current version and is not an acceptable fix.

Keep these limits until Firebase Tools publishes a compatible dependency tree:

- Use Firebase Tools only with an explicit `demo-*` project and local emulator host.
- Do not include Firebase Tools in a production image or runtime dependency bundle.
- Do not process untrusted archive paths, glob patterns, baggage headers, or UUID buffers through Firebase Tools commands.
- Review `npm audit` and the latest Firebase Tools release before each deployment tool update.
- Remove this acceptance when a current compatible release resolves the findings.

This acceptance does not cover a high or critical finding. A new high or critical finding blocks the release until it is removed, isolated, or accepted through a separate security review.
