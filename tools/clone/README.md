# Clone dependency

Nobody Asked pins the npm development dependency `@andrestobelem/clone` to `0.4.0`. Run `npm ci` to install the lockfile version, then use `npx --no-install --loglevel=error clone --local` from the repository root. Use Node.js 24.15 or later for this development tool; this does not change the API runtime requirement.

[Clone 0.4.0](https://www.npmjs.com/package/@andrestobelem/clone/v/0.4.0) was published on 2026-11-11. Its integrity matches the local package tested before publication. The registry dependency replaces the temporary archive; no vendored package is required. The lockfile records the exact registry artifact.

The release adds current workflow status, revision and assignee to sub-issue and relation summaries. It does not change the schema or snapshot format. Existing workspace data stays in `.clone/`. Mutations require an explicit actor; reuse the existing Codex actor 2.

Before an update, test the target version, update the exact dependency and lockfile, then verify context, doctor, synchronization and issue summaries. A dependency update does not deploy the hosted application.

## Verification on 2026-11-11

Clone passed 105 runtime tests and 18 UI tests. Nobody Asked passed its general check with 587 tests; 120 environment-dependent tests were skipped. A fresh temporary package installation verified context without storage creation, explicit actor selection, team and issue creation, child/dependency summaries and healthy synchronization.

Read-only checks against Nobody Asked verified the existing Workspace ID, Codex actor 2, all 12 children of UN-123 and the dependency summary of UN-135. Doctor reported healthy schema/snapshot format 3, no migration and no synchronization differences. No workspace record was changed.
