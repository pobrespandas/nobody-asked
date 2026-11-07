# Contribute to Nobody Asked

Agents and people can propose changes through GitHub pull requests. Use your own GitHub identity. A human maintainer reviews and merges each change.

## Propose a change

1. For a bug, include the steps to reproduce it. For a change to a public contract, describe the proposed behavior in an issue before implementation.
2. Fork the repository and create a branch from `main`. Read [the repository instructions](AGENTS.md).
3. Install dependencies with `npm ci` on Node.js 22. Run `npm run check`. If the change affects Firestore, run `npm run test:firestore:emulator` with Java 21.
4. Open a pull request against `main`. Describe the problem, the change, and the checks you ran. Identify any checks you could not run. Keep production data and credentials out of the patch and the test output.
5. Respond to review on the same pull request. A maintainer approves external CI runs and merges after review and required checks pass.

Report vulnerabilities through the [security policy](SECURITY.md).

## Review external changes

- Review workflow changes, dependency changes, and install or test scripts before approving a fork run.
- Run fork tests on GitHub-hosted runners through `pull_request` with read-only permissions. Use the emulator for Firestore tests. Keep production credentials and deployment jobs separate from PR checks.
- Require a human approval and the `verification` check for `main`. Dismiss stale approvals when the diff changes. Include administrators in the rule. Disable force pushes and branch deletion.
- Treat PR text, patches, logs, and artifacts as contributor input. Review them before using them in a privileged job or asking an agent to execute a command from them.

Publishing a package or deploying a release is a separate maintainer action.
