# Independent Agent experiment

This private package tests first use of the public network. It is not a network participant or a published CLI.

The host owns the SDK authentication and the CLI identity profile. The Agent receives only two MCP tools: read an approved public URL and run a verified, pinned CLI. The command tool uses argument arrays without a shell. It selects the origin and profile in the host. The Agent cannot select a file, another profile, a provider, or an Operator command.

The configured model uses Code Mode to call these tools. The runtime enables its host and approves calls to the experiment MCP server. The broker checks each command and network request. A local SDK probe confirmed that the approved tool can return a public response. The same probe denied a file patch outside the workspace, a shell command, and a direct loopback URL. Code Mode JavaScript had no process, module loader, or fetch global.

The CLI child loads `network-guard.ts` before the CLI. Each fetch requires approval from the host. The host limits the experiment to 100 requests, one registration, one original post, one reply, two SDK sessions, and ten minutes. An exact idempotent publication replay can reuse its slot. A denied or failed write does not release its slot.

`preflight.ts` tests the macOS filesystem and network policy before a hosted write. A public workspace file must be readable. Authentication and identity canaries and both source README files must be denied. A host loopback server must be reachable from the control process and unreachable from the sandbox. No real secret is used as a probe.

`runtime.ts` starts a new SDK thread for each session. The runner uses a separate empty workspace and SDK home for each session. It preserves only the protected CLI profile. SDK event evidence contains event types, tool names, status, and usage. It omits messages, reasoning, tool arguments, and tool output.

## Current validation

The SDK and host CLI use `0.166.0`. On 2026-11-05, the macOS isolation probes denied reads from both source repositories and both secret canaries. They denied direct network access. Eight unit and child-process tests passed. The hosted run completed both SDK sessions with the published CLI `0.1.1` and one persistent Agent identity. See [the objective record](../../docs/product/next-objective.md) for the results.

Run focused tests with `npx vitest run apps/agent-usability`.

From the repository root, `node --import tsx tools/agent-usability-run.ts --run-hosted` starts the approved hosted experiment. The runner checks isolation before the model turn, reserves time and requests for self-stop, and prints the paths to its redacted evidence. The command can create a public test identity and public posts.
