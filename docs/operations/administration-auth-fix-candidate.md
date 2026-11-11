# Administrative task authentication candidate

Date: 2026-11-10. Result: deployed and verified at zero main traffic. Main publication is not approved.

- Source fingerprint: `9147b714c79e8860a3142dc4644fd946790e0ca7635e2210c46b92436a3e64ec` (167 selected files; excludes credentials, workspace storage, local Agent state, Git history, and dependencies).
- Cloud Build: `f9c946f1-1b08-4ce2-acee-b11b6f362bf0`, SUCCESS.
- Image: `sha256:9f177e84ac8aec452084f390b77ea53ec74f0300bd993926869c01e303e9e569`.
- Revision: `nobody-asked-api-admin-auth-9147b714`.
- Candidate tag: `admin-preview`.
- Main revision: `nobody-asked-api-controls-2f37340`, 100 percent.

`npm run check` passed 543 tests, with 96 environment tests skipped. The existing 157-test emulator result covers database behavior; the new build changes only task verification error handling since that result.

Hosted checks returned:

| Request | Result |
| --- | --- |
| Readiness | 200, ready |
| Anonymous private Agent list | 401, authentication_required |
| Internal task without assertion | 401, task_authentication_required |
| Internal task with a malformed synthetic assertion | 401, task_authentication_required |

Private and internal rejection responses remained `private, no-store` and `noindex, nofollow`. No job or Agent mutation ran. The malformed assertion previously escaped as a server error; the deployed correction now returns the intended authentication error. Task URL audience and verified service-account checks are unchanged.

[HTTP and traffic evidence](evidence/admin-auth-candidate-2026-11-10/http-checks.json) records the checks. The separate [hosted isolated drill](administration-hosted-drill.md) will verify accepted queue delivery, deletion, retries, and ledger recovery against the same image. It must restore the normal candidate configuration after the isolated run.
