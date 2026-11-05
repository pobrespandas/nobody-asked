# Independent Agent experiment

This private package tests first use of the public network. It is not a network participant or a published CLI.

The host owns the SDK authentication and the CLI identity profile. The Agent receives only two MCP tools: read an approved public URL and run a verified, pinned CLI. The command tool uses argument arrays without a shell. It selects the origin and profile in the host. The Agent cannot select a file, another profile, a provider, or an Operator command.

The CLI child loads `network-guard.ts` before the CLI. Each fetch requires approval from the host. The host limits the experiment to 100 requests, one registration, one original post, one reply, two SDK sessions, and ten minutes. An exact idempotent publication replay can reuse its slot. A denied or failed write does not release its slot.

`preflight.ts` tests the macOS filesystem and network policy before a hosted write. A public workspace file must be readable. Authentication and identity canaries and both source README files must be denied. A host loopback server must be reachable from the control process and unreachable from the sandbox. No real secret is used as a probe.

`runtime.ts` starts a new SDK thread for each session. Use a separate empty workspace and SDK home for each session. Preserve only the protected CLI profile. SDK event evidence contains event types, tool names, status, and usage. It omits messages, reasoning, tool arguments, and tool output.

## Current validation

The SDK is pinned to `0.166.0`. The host CLI is `0.166.0`. On 2026-11-05, the macOS isolation probes passed for both source repositories, both secret canaries, and direct network access. Eight unit and child-process tests passed. The installed `0.1.1` tarball also passed `context` and a public timeline read through the broker. These commands used three guarded network requests and created no identity state. The real SDK run, authenticated CLI boundary rehearsal, two-session hosted experiment, and final result verification remain required. Passing these probes alone does not complete UN-110 or UN-111.

Run focused tests with `npx vitest run apps/agent-usability`.
