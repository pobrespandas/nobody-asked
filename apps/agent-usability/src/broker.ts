import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { cliArguments, NetworkPolicy, type NetworkIntent } from "./policy.js";

const execute = promisify(execFile);
export interface BrokerOptions {
  policy: NetworkPolicy;
  cliPath: string;
  guardPath: string;
  stateDirectory: string;
  profile?: string;
  home: string;
  workspace: string;
  redact: (text: string) => Promise<string>;
  observePublicRead?: (route: string, status: number) => Promise<void>;
  observeCommand?: (event: {
    command: string;
    exitCode: number;
    durationMs: number;
  }) => Promise<void>;
}

async function jsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65_536) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A JSON object is required.");
  return value as Record<string, unknown>;
}

export async function startBroker(options: BrokerOptions) {
  const token = randomBytes(32).toString("hex");
  let origin = "";
  let busy = false;
  const authenticated = (value: string | undefined): boolean => {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(value ?? "");
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  };
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (
      !authenticated(request.headers.authorization) ||
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin)
    ) {
      response.writeHead(403).end('{"error":"forbidden"}');
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let id: unknown = null;
    try {
      const message = await jsonBody(request);
      if (request.url === "/guard") {
        options.policy.allow(message as unknown as NetworkIntent);
        response.end("{}");
        return;
      }
      if (request.url !== "/mcp") throw new Error("Unknown endpoint.");
      id = message.id ?? null;
      if (typeof message.method !== "string")
        throw new Error("Invalid MCP method.");
      if (message.method.startsWith("notifications/")) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "bounded-experiment", version: "1.0.0" },
        };
      } else if (message.method === "ping") result = {};
      else if (message.method === "tools/list")
        result = {
          tools: [
            {
              name: "fetch_url",
              description:
                "Read a public HTTPS URL within the task's approved site. Redirects are disabled.",
              inputSchema: {
                type: "object",
                properties: { url: { type: "string" } },
                required: ["url"],
                additionalProperties: false,
              },
            },
            {
              name: "run_command",
              description:
                "Run an installed, pinned command as an argument array. No shell, file access, or user-selected runtime state is available. State persists between sessions.",
              inputSchema: {
                type: "object",
                properties: {
                  argv: { type: "array", items: { type: "string" } },
                },
                required: ["argv"],
                additionalProperties: false,
              },
            },
          ],
        };
      else if (message.method === "tools/call") {
        if (busy) throw new Error("Run tools one at a time.");
        busy = true;
        try {
          options.policy.budget.assertActive();
          const params = message.params as {
            name?: string;
            arguments?: Record<string, unknown>;
          };
          let output: string;
          if (
            params.name === "fetch_url" &&
            typeof params.arguments?.url === "string"
          ) {
            options.policy.allow({ url: params.arguments.url, method: "GET" });
            const reply = await fetch(params.arguments.url, {
              redirect: "error",
              signal: AbortSignal.timeout(20_000),
            });
            const reader = reply.body?.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            if (reader) {
              try {
                while (true) {
                  const part = await reader.read();
                  if (part.done) break;
                  size += part.value.byteLength;
                  if (size > 300_000)
                    throw new Error("Public response is too large.");
                  chunks.push(part.value);
                }
              } finally {
                await reader.cancel();
              }
            }
            output = JSON.stringify({
              status: reply.status,
              body: Buffer.concat(chunks).toString("utf8"),
            });
            const path = new URL(params.arguments.url).pathname;
            const discoveryPaths = [
              "/",
              "/cli.md",
              "/skills/nobody-asked/SKILL.md",
              "/v1",
              "/v1/openapi.json",
            ];
            await options.observePublicRead?.(
              discoveryPaths.includes(path) ? path : "other",
              reply.status,
            );
          } else if (
            params.name === "run_command" &&
            Array.isArray(params.arguments?.argv)
          ) {
            const args = cliArguments(params.arguments.argv as string[]);
            const started = Date.now();
            let exitCode = 0;
            try {
              const child = await execute(
                process.execPath,
                [
                  "--import",
                  options.guardPath,
                  options.cliPath,
                  ...args,
                  "--base-url",
                  options.policy.origin,
                  "--state-dir",
                  options.stateDirectory,
                  "--profile",
                  options.profile ?? "experiment",
                ],
                {
                  cwd: options.workspace,
                  env: {
                    PATH: "/usr/bin:/bin",
                    HOME: options.home,
                    NOBODY_GUARD_URL: `${origin}/guard`,
                    NOBODY_GUARD_TOKEN: token,
                  },
                  timeout: Math.min(
                    60_000,
                    Math.max(1, options.policy.budget.deadline - Date.now()),
                  ),
                  maxBuffer: 400_000,
                },
              );
              output = JSON.stringify({
                exitCode: 0,
                stdout: child.stdout,
                stderr: child.stderr,
              });
            } catch (error) {
              const child = error as {
                code?: unknown;
                stdout?: string;
                stderr?: string;
              };
              exitCode = typeof child.code === "number" ? child.code : 1;
              output = JSON.stringify({
                exitCode: typeof child.code === "number" ? child.code : 1,
                stdout: child.stdout ?? "",
                stderr: child.stderr ?? "Command did not complete.",
              });
            }
            await options.observeCommand?.({
              command: args[0] ?? "help",
              exitCode,
              durationMs: Date.now() - started,
            });
          } else throw new Error("Unknown tool or invalid arguments.");
          result = {
            content: [{ type: "text", text: await options.redact(output) }],
          };
        } finally {
          busy = false;
        }
      } else throw new Error("Unknown MCP method.");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch {
      // Never include request bodies, child environments, or authentication in errors.
      if (request.url === "/guard")
        response.writeHead(403).end('{"error":"policy_denied"}');
      else
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message:
                "Tool request is invalid or exceeds the experiment policy.",
            },
          }),
        );
    }
  });
  server.requestTimeout = 65_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No broker address.");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
