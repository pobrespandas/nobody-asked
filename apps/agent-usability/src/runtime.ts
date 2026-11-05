import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadEvent,
} from "@openai/codex-sdk";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { permissionConfig } from "./preflight.js";
import type { ExperimentBudget } from "./policy.js";

export interface RuntimeOptions {
  codexPath: string;
  sdkHome: string;
  home: string;
  workspace: string;
  broker: { url: string; token: string };
  model: string;
  effort: ModelReasoningEffort;
}

export function sdkOptions(options: RuntimeOptions): CodexOptions {
  return {
    codexPathOverride: options.codexPath,
    // This is a complete environment, not an overlay of the developer environment.
    env: {
      PATH: "/usr/bin:/bin",
      HOME: options.home,
      CODEX_HOME: options.sdkHome,
    },
    configOverrides: [
      permissionConfig(options.workspace),
      'default_permissions="experiment"',
      "permissions.experiment.network.enabled=false",
      'shell_environment_policy.inherit="none"',
      "mcp_servers.experiment.url=" + JSON.stringify(options.broker.url),
      'mcp_servers.experiment.http_headers={"Authorization"=' +
        JSON.stringify(`Bearer ${options.broker.token}`) +
        "}",
      "mcp_servers.experiment.required=true",
      "mcp_servers.experiment.supports_parallel_tool_calls=false",
      ...[
        "shell_tool",
        "unified_exec",
        "apps",
        "plugins",
        "browser_use",
        "browser_use_external",
        "in_app_browser",
        "view_image",
        "image_generation",
        "code_mode_host",
        "multi_agent",
        "multi_agent_v2",
      ].map((feature) => `features.${feature}=false`),
    ],
  };
}

/** Copy only SDK authentication. Do not copy developer instructions or configuration. */
export async function prepareSdkHome(
  sourceAuth: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await chmod(destination, 0o700);
  await copyFile(sourceAuth, join(destination, "auth.json"));
  await chmod(join(destination, "auth.json"), 0o600);
}

/** Store event metadata only. Tool arguments, output, reasoning, and text remain ephemeral. */
export function evidenceEvent(event: ThreadEvent): Record<string, unknown> {
  if (event.type === "turn.completed")
    return { type: event.type, usage: event.usage };
  if (event.type === "thread.started")
    return { type: event.type, threadId: event.thread_id };
  if (
    event.type === "item.completed" ||
    event.type === "item.started" ||
    event.type === "item.updated"
  ) {
    const item = event.item;
    return {
      type: event.type,
      itemType: item.type,
      ...(item.type === "mcp_tool_call"
        ? { server: item.server, tool: item.tool, status: item.status }
        : {}),
    };
  }
  return { type: event.type };
}

export async function redactIdentity(
  text: string,
  identityFile: string,
): Promise<string> {
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(await readFile(identityFile, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return text;
    throw new Error("Cannot verify secret redaction.");
  }
  let result = text;
  for (const key of ["credential", "privateKey", "nextPrivateKey"]) {
    const secret = state[key];
    if (typeof secret === "string" && secret) {
      result = result.replaceAll(secret, "[REDACTED]");
      result = result.replaceAll(
        JSON.stringify(secret).slice(1, -1),
        "[REDACTED]",
      );
    }
  }
  return result;
}

export async function runSession(
  options: RuntimeOptions,
  budget: ExperimentBudget,
  task: string,
  record: (event: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  budget.startSession();
  const codex = new Codex(sdkOptions(options));
  // Always create a new thread. Never resume the first conversation.
  const thread = codex.startThread({
    model: options.model,
    modelReasoningEffort: options.effort,
    workingDirectory: options.workspace,
    skipGitRepoCheck: true,
    webSearchMode: "disabled",
    approvalPolicy: "never",
  });
  const stream = await thread.runStreamed(task, {
    signal: AbortSignal.timeout(Math.max(1, budget.deadline - Date.now())),
  });
  let completed = false;
  for await (const event of stream.events) {
    await record(evidenceEvent(event));
    if (event.type === "turn.completed") completed = true;
    if (event.type === "turn.failed" || event.type === "error")
      throw new Error(
        "SDK session failed. Raw provider errors are not stored.",
      );
  }
  if (!completed) throw new Error("SDK session ended without completion.");
}
