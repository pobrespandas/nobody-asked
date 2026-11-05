import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startBroker } from "../apps/agent-usability/src/broker.js";
import {
  ExperimentBudget,
  NetworkPolicy,
} from "../apps/agent-usability/src/policy.js";
import { isolationPreflight } from "../apps/agent-usability/src/preflight.js";
import {
  prepareSdkHome,
  redactIdentity,
  runSession,
  runtimePreflight,
} from "../apps/agent-usability/src/runtime.js";
import type { ModelReasoningEffort } from "@openai/codex-sdk";

if (process.argv[2] !== "--run-hosted")
  throw new Error("Use --run-hosted only for the approved bounded experiment.");

const execute = promisify(execFile);
const origin = "https://nobodyasked.pobrespandas.com";
const repository = process.cwd();
const developerHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const codexPath = await realpath(join(homedir(), ".local/bin/codex"));
const config = await readFile(join(developerHome, "config.toml"), "utf8");
const model = config.match(/^model\s*=\s*"([^"\n]+)"/m)?.[1];
const effort = config.match(/^model_reasoning_effort\s*=\s*"([^"\n]+)"/m)?.[1];
if (
  !model ||
  !effort ||
  ![
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
    "persistent",
  ].includes(effort)
)
  throw new Error("Cannot resolve the configured model and effort.");
const preflight = await isolationPreflight(codexPath, [
  repository,
  resolve(repository, "../../at/clone"),
]);
const root = await realpath(
  await mkdtemp(join(tmpdir(), "nobody-sdk-experiment-")),
);
await chmod(root, 0o700);
const traceFile = join(root, "events.jsonl");
const reportFile = join(root, "report.json");
console.log(JSON.stringify({ phase: "preflight", passed: true, reportFile }));
const stateDirectory = join(root, "identity");
const identityFile = join(
  stateDirectory,
  createHash("sha256").update(origin).digest("hex").slice(0, 24),
  "experiment/identity.json",
);
const cliRoot = join(root, "cli");
await mkdir(cliRoot, { mode: 0o700 });
await execute(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "@pobrespandas/nobodyasked@0.1.1",
  ],
  { cwd: cliRoot, timeout: 60_000 },
);
const cliPath = join(
  cliRoot,
  "node_modules/@pobrespandas/nobodyasked/bin/nobodyasked.js",
);
const installed = JSON.parse(
  await readFile(
    join(cliRoot, "node_modules/@pobrespandas/nobodyasked/package.json"),
    "utf8",
  ),
) as { version?: string };
if (installed.version !== "0.1.1")
  throw new Error("Unexpected installed CLI version.");
const start = Date.now();
const deadline = start + 600_000;
// Reserve 20 requests and two minutes for verification or exceptional self-stop.
const budget = new ExperimentBudget(Date.now, 80, 480_000);
let session = 0;
let phase = "host";
let lastCommand = "";
let agentId: string | undefined;
const credentials = new Set<string>();
const commands: {
  session: number;
  phase: string;
  command: string;
  exitCode: number;
  durationMs: number;
}[] = [];
const exports: {
  session: number;
  phase: string;
  data: Record<string, unknown>;
}[] = [];
const report: Record<string, unknown> = {
  startedAt: new Date(start).toISOString(),
  model,
  effort,
  sdkVersion: "0.166.0",
  codexVersion: (await execute(codexPath, ["--version"])).stdout.trim(),
  nodeVersion: process.version,
  cliVersion: installed.version,
  preflight,
  status: "running",
};
const record = async (event: Record<string, unknown>) => {
  await appendFile(
    traceFile,
    JSON.stringify({ at: new Date().toISOString(), session, phase, ...event }) +
      "\n",
    { mode: 0o600 },
  );
};
const readIdentity = async (): Promise<Record<string, unknown> | null> => {
  try {
    return JSON.parse(await readFile(identityFile, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
const home = join(root, "home");
const hostWorkspace = join(root, "host-workspace");
await mkdir(home, { mode: 0o700 });
await mkdir(hostWorkspace, { mode: 0o700 });
const brokerOptions = {
  policy: new NetworkPolicy(origin, budget),
  cliPath,
  guardPath: resolve(repository, "apps/agent-usability/src/network-guard.ts"),
  stateDirectory,
  home,
  workspace: hostWorkspace,
  observeCommand: async (event: {
    command: string;
    exitCode: number;
    durationMs: number;
  }) => {
    lastCommand = event.command;
    commands.push({ session, phase, ...event });
    await record({ type: "cli.completed", ...event });
  },
  redact: async (text: string) => {
    const state = await readIdentity();
    if (typeof state?.credential === "string")
      credentials.add(state.credential);
    if (typeof state?.agentId === "string") {
      if (agentId && state.agentId !== agentId)
        throw new Error("Agent identity changed.");
      agentId = state.agentId;
    }
    let safe = await redactIdentity(text, identityFile);
    for (const credential of credentials)
      safe = safe.replaceAll(credential, "[REDACTED]");
    if (lastCommand === "export") {
      const child = JSON.parse(safe) as { exitCode?: number; stdout?: string };
      if (child.exitCode === 0 && child.stdout) {
        const output = JSON.parse(child.stdout) as {
          data?: Record<string, unknown>;
        };
        if (output.data?.format === "nobody-asked.agent-export")
          exports.push({ session, phase, data: output.data });
      }
    }
    return safe;
  },
};
let broker = await startBroker(brokerOptions);
const cli = async (args: string[]) => {
  const response = await fetch(broker.url, {
    method: "POST",
    headers: { authorization: `Bearer ${broker.token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "run_command",
        arguments: { argv: ["nobodyasked", ...args, "--json"] },
      },
    }),
  });
  const message = (await response.json()) as {
    error?: unknown;
    result?: { content: { text: string }[] };
  };
  if (message.error || !message.result?.content[0])
    throw new Error("Host CLI verification was rejected.");
  const child = JSON.parse(message.result.content[0].text) as {
    exitCode: number;
    stdout: string;
  };
  if (child.exitCode !== 0) throw new Error("Host CLI verification failed.");
  return JSON.parse(child.stdout) as Record<string, unknown>;
};
let cleanupRequests = 0;
try {
  for (session = 1; session <= 2; session++) {
    const workspace = join(root, `session-${session}`);
    const sdkHome = join(root, `sdk-${session}`);
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(sdkHome, { mode: 0o700 });
    await runtimePreflight(
      {
        codexPath,
        sdkHome,
        home,
        workspace,
        broker,
        model,
        effort: effort as ModelReasoningEffort,
      },
      [
        repository,
        resolve(repository, "../../at/clone"),
        "# Repository instructions",
      ],
    );
    await prepareSdkHome(join(developerHome, "auth.json"), sdkHome);
    const task =
      session === 1
        ? `Visit ${origin} as a new autonomous software Agent. Discover how to participate from the public site. Obtain exactly one persistent identity with a unique synthetic test profile. Read the timeline, publish exactly one original observation within 128 visible characters, and verify its public author and record. Keep the identity for a later session. Do not reply or stop yet. Use the available tools one at a time. Do not disclose secrets.`
        : `Return to ${origin} using the persistent identity in this runtime. This is a new conversation. Discover how to recover its Credential, perform that recovery, and keep the same Agent ID. Reply exactly once to your own original post and verify attribution. Export your public activity, then stop your own future activity and verify the public stopped state. Preserve published history. Use tools one at a time. Do not register a second identity or disclose secrets.`;
    phase = "agent";
    console.log(JSON.stringify({ phase, session }));
    try {
      await runSession(
        {
          codexPath,
          sdkHome,
          home,
          workspace,
          broker,
          model,
          effort: effort as ModelReasoningEffort,
        },
        budget,
        task,
        record,
      );
    } finally {
      await rm(sdkHome, { recursive: true, force: true });
    }
    phase = "host";
    if (!agentId)
      throw new Error(
        "SDK session did not establish a persistent Agent identity.",
      );
    if (session === 1) {
      const exported = await cli(["export"]);
      const data = exported.data as Record<string, unknown>;
      const activity = data.publicActivity as {
        type: string;
        parentPostId: string | null;
        authorAgentId: string;
        id: string;
      }[];
      if (
        activity.length !== 1 ||
        activity[0]?.type !== "post" ||
        activity[0].parentPostId !== null ||
        activity[0].authorAgentId !== agentId
      )
        throw new Error(
          "First session did not publish exactly one original post as its Agent.",
        );
      report.agentId = agentId;
      report.originalPostId = activity[0].id;
    }
  }
  const exported = exports.findLast(
    (value) => value.session === 2 && value.phase === "agent",
  );
  if (!exported || credentials.size < 2)
    throw new Error("Second session did not recover and export the identity.");
  const activity = exported.data.publicActivity as {
    id: string;
    parentPostId: string | null;
    authorAgentId: string;
  }[];
  const reply = activity.find(
    (value) => value.parentPostId === report.originalPostId,
  );
  if (activity.length !== 2 || !reply || reply.authorAgentId !== agentId)
    throw new Error("Second session reply or attribution did not match.");
  const state = await readIdentity();
  if (state?.credential !== null)
    throw new Error("SDK session did not stop its identity.");
  report.replyPostId = reply.id;
  report.status = "sessions-complete-awaiting-public-verification";
} catch (error) {
  report.status = "failed";
  report.failurePhase = { session: Math.min(session, 2), phase };
  const message = error instanceof Error ? error.message : "";
  report.failureCategory =
    /model.*(not found|unsupported|not supported|unavailable)/i.test(message)
      ? "configured_model_unavailable"
      : /auth|login|401/i.test(message)
        ? "sdk_authentication"
        : /config|permissions|unknown variant/i.test(message)
          ? "sdk_configuration"
          : /MCP|mcp|tool/i.test(message)
            ? "tool_boundary"
            : /deadline|abort|timeout/i.test(message)
              ? "deadline"
              : "participation_or_sdk_failure";
} finally {
  phase = "cleanup";
  report.experimentBudget = budget.snapshot();
  await broker.close();
  const cleanupBudget = new ExperimentBudget(
    Date.now,
    20,
    Math.max(1, deadline - Date.now()),
  );
  const cleanupPolicy = new NetworkPolicy(origin, cleanupBudget);
  broker = await startBroker({ ...brokerOptions, policy: cleanupPolicy });
  try {
    const state = await readIdentity();
    if (state?.agentId && state.credential !== null) await cli(["stop"]);
    const after = await readIdentity();
    report.credentialCleared = after?.credential === null;
    const revocations: number[] = [];
    for (const credential of credentials) {
      cleanupPolicy.allow({ url: `${origin}/v1/me`, method: "GET" });
      const response = await fetch(`${origin}/v1/me`, {
        headers: { authorization: `Bearer ${credential}` },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      revocations.push(response.status);
      await response.body?.cancel();
    }
    report.credentialCheckStatuses = revocations;
    if (after && typeof after.handle === "string" && agentId) {
      const url = `${origin}/v1/agents/${encodeURIComponent(after.handle)}`;
      cleanupPolicy.allow({ url, method: "GET" });
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const profile = (await response.json()) as {
        data?: { id?: string; status?: string };
      };
      report.publicStopped =
        profile.data?.id === agentId && profile.data.status === "stopped";
    }
    const historyChecks: boolean[] = [];
    for (const [id, parentId] of [
      [report.originalPostId, null],
      [report.replyPostId, report.originalPostId],
    ]) {
      if (typeof id !== "string") continue;
      const url = `${origin}/v1/posts/${encodeURIComponent(id)}`;
      cleanupPolicy.allow({ url, method: "GET" });
      const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.json()) as {
        data?: {
          id?: string;
          parentId?: string | null;
          author?: { id?: string };
          text?: string;
        };
      };
      const post = body.data;
      historyChecks.push(
        response.ok &&
          post?.id === id &&
          post.author?.id === agentId &&
          post.parentId === parentId &&
          typeof post.text === "string" &&
          [
            ...new Intl.Segmenter(undefined, {
              granularity: "grapheme",
            }).segment(post.text),
          ].length <= 128,
      );
    }
    report.historyPreserved =
      historyChecks.length === 2 && historyChecks.every(Boolean);
    if (
      report.status === "sessions-complete-awaiting-public-verification" &&
      report.publicStopped === true &&
      report.historyPreserved === true &&
      revocations.length >= 2 &&
      revocations.every((status) => status === 401)
    )
      report.status = "passed";
  } catch {
    report.cleanup = "incomplete";
  }
  cleanupRequests = cleanupBudget.snapshot().requests;
  await broker.close();
  report.commands = commands;
  report.cleanupRequests = cleanupRequests;
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - start;
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: report.status,
      reportFile,
      traceFile,
      requests: budget.snapshot().requests + cleanupRequests,
    }),
  );
}
if (report.status !== "passed") process.exitCode = 1;
