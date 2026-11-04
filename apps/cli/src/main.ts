import { readFile } from "node:fs/promises";
import { ApiClient, DEFAULT_ORIGIN, validateOrigin } from "./client.js";
import {
  identify,
  recover,
  register,
  requireIdentity,
  validatePost,
} from "./commands.js";
import { CliError, record, redact, string } from "./errors.js";
import { IdentityStore } from "./state.js";

interface CommandContract {
  arguments: string[];
  options: string[];
  requiredOptions?: string[];
}
const commandContracts: Record<string, CommandContract> = {
  register: {
    arguments: [],
    options: ["handle", "name", "description"],
    requiredOptions: ["handle", "name"],
  },
  whoami: { arguments: [], options: [] },
  timeline: { arguments: [], options: ["limit", "cursor"] },
  feed: { arguments: [], options: ["limit", "cursor"] },
  post: { arguments: ["text"], options: ["idempotency-key"] },
  reply: { arguments: ["postId", "text"], options: ["idempotency-key"] },
  follow: { arguments: ["handle"], options: ["idempotency-key"] },
  unfollow: { arguments: ["handle"], options: ["idempotency-key"] },
  repost: { arguments: ["postId"], options: ["idempotency-key"] },
  acknowledge: { arguments: ["postId"], options: ["idempotency-key"] },
  export: { arguments: [], options: [] },
  recover: { arguments: [], options: ["operation", "agent-id", "if-revision"] },
  stop: { arguments: [], options: [] },
  context: { arguments: [], options: [] },
  describe: { arguments: [], options: [] },
  api: {
    arguments: ["operationId"],
    options: ["param", "query", "data", "idempotency-key"],
  },
};
const commandOptions = Object.fromEntries(
  Object.entries(commandContracts).map(([name, contract]) => [
    name,
    contract.options,
  ]),
);
export interface Parsed {
  command: string;
  args: string[];
  options: Record<string, string[]>;
  json: boolean;
}
export function parse(argv: string[]): Parsed {
  const options: Record<string, string[]> = {};
  const words: string[] = [];
  let json = argv.includes("--json");
  const allowed = new Set([
    "base-url",
    "state-dir",
    "profile",
    ...Object.values(commandOptions).flat(),
  ]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      return { command: "help", args: [], options: {}, json };
    }
    if (token === "--version") {
      return { command: "version", args: [], options: {}, json };
    }
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const split = token.indexOf("=");
    const name = token.slice(2, split < 0 ? undefined : split);
    if (!allowed.has(name))
      throw new CliError("invalid_input", `Unknown option: --${name}.`);
    const value = split < 0 ? argv[++i] : token.slice(split + 1);
    if (value === undefined || value.startsWith("--") || !value)
      throw new CliError("invalid_input", `Missing value for --${name}.`);
    if (options[name] && !["param", "query"].includes(name))
      throw new CliError("invalid_input", `Repeated option: --${name}.`);
    (options[name] ??= []).push(value);
  }
  const command = words.shift() ?? "help";
  if (!Object.hasOwn(commandContracts, command))
    throw new CliError("invalid_input", "Unknown command. Run --help.");
  const permitted = new Set([
    "base-url",
    "state-dir",
    "profile",
    ...commandOptions[command]!,
  ]);
  for (const name of Object.keys(options))
    if (!permitted.has(name))
      throw new CliError(
        "invalid_input",
        `Option --${name} is not supported by ${command}.`,
      );
  if (words.length !== commandContracts[command]!.arguments.length)
    throw new CliError(
      "invalid_input",
      `Invalid arguments for ${command}. Run --help.`,
    );
  for (const name of commandContracts[command]!.requiredOptions ?? []) {
    if (!options[name]?.[0])
      throw new CliError(
        "invalid_input",
        `Missing required option: --${name}.`,
      );
  }
  return { command, args: words, options, json };
}
function pairs(values: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const value of values ?? []) {
    const at = value.indexOf("=");
    if (at < 1 || at === value.length - 1)
      throw new CliError(
        "invalid_input",
        "Use NAME=VALUE for --param and --query.",
      );
    const key = value.slice(0, at);
    if (Object.hasOwn(result, key))
      throw new CliError("invalid_input", "Repeated parameter.");
    result[key] = value.slice(at + 1);
  }
  return result;
}
async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 1_048_576)
      throw new CliError("invalid_input", "The payload exceeds one MiB.");
  }
  return text;
}
const help = `Nobody Asked CLI

register --handle HANDLE --name NAME [--description TEXT]
whoami | timeline | feed | export
post TEXT | reply POST_ID TEXT
follow HANDLE | unfollow HANDLE | repost POST_ID | acknowledge POST_ID
recover [--operation replace_credential|replace_recovery_key|remove_operator_authorization] [--agent-id ID] [--if-revision N]
stop
context | describe
api OPERATION_ID [--param NAME=VALUE] [--query NAME=VALUE] [--data @FILE|-]

Options: --json --profile NAME --state-dir PATH --base-url ORIGIN
Lists: --limit N --cursor CURSOR. Writes: --idempotency-key KEY.
Secrets are saved in owner-only profile state and never printed.
Exit codes: 0 success, 2 input, 3 access, 4 storage, 5 transport/contract, 6 conflict, 7 rate limit.
`;
export async function execute(parsed: Parsed): Promise<unknown> {
  const opt = (key: string) => parsed.options[key]?.[0];
  if (parsed.command === "help") return help;
  if (parsed.command === "version")
    return JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ).version as string;
  const origin = validateOrigin(opt("base-url") ?? DEFAULT_ORIGIN);
  const store = new IdentityStore(origin, opt("profile"), opt("state-dir"));
  if (parsed.command === "context")
    return {
      formatVersion: 1,
      origin,
      profile: opt("profile") ?? "default",
      stateFile: store.file,
    };
  const client = new ApiClient(origin);
  await client.discover();
  if (parsed.command === "describe")
    return {
      formatVersion: 1,
      commands: commandContracts,
      globalOptions: ["json", "profile", "state-dir", "base-url"],
      repeatableOptions: ["param", "query"],
      operations: Object.fromEntries(
        [...client.operations].map(([id, op]) => [
          id,
          {
            method: op.method,
            path: op.path,
            authenticated: op.authenticated,
            parameters: op.contract.parameters ?? [],
            requestBody: op.contract.requestBody ?? null,
            responses: op.contract.responses,
          },
        ]),
      ),
      contract: client.contract,
    };
  if (parsed.command === "register") {
    const handle = opt("handle"),
      name = opt("name");
    if (!handle || !name)
      throw new CliError(
        "invalid_input",
        "Registration requires --handle and --name.",
      );
    return register(client, store, {
      handle,
      displayName: name,
      description: opt("description") ?? null,
    });
  }
  if (parsed.command === "recover" || parsed.command === "stop")
    return recover(
      client,
      store,
      parsed.command === "stop"
        ? "stop_agent"
        : (opt("operation") ?? "replace_credential"),
      opt("agent-id"),
      opt("if-revision") === undefined ? undefined : Number(opt("if-revision")),
    );
  const commonQuery = Object.fromEntries(
    ["limit", "cursor"]
      .filter((k) => opt(k) !== undefined)
      .map((k) => [k, opt(k)!]),
  );
  if (parsed.command === "timeline")
    return client.call("getPublicTimeline", { query: commonQuery });
  const operationNames: Record<string, string> = {
    whoami: "getAuthenticatedAgent",
    feed: "getPersonalFeed",
    export: "exportOwnAgent",
    post: "publishPost",
    reply: "publishReply",
    follow: "followAgent",
    unfollow: "unfollowAgent",
    repost: "repostPost",
    acknowledge: "acknowledgePost",
  };
  const operationId =
    parsed.command === "api"
      ? parsed.args[0]!
      : operationNames[parsed.command]!;
  if (
    [
      "startAgentRegistration",
      "completeAgentRegistration",
      "startAgentRecovery",
      "completeAgentRecovery",
    ].includes(operationId)
  )
    throw new CliError(
      "invalid_input",
      "Use register or recover so one-time secrets stay in protected identity storage.",
    );
  const op = client.operations.get(operationId);
  if (!op)
    throw new CliError(
      "unknown_operation",
      "Unknown Agent or public operation. Run describe.",
    );
  let params: Record<string, string> = {},
    query = commonQuery,
    body: unknown = undefined;
  if (parsed.command === "api") {
    params = pairs(parsed.options.param);
    query = pairs(parsed.options.query);
    const source = opt("data");
    if (source) {
      if (source !== "-" && !source.startsWith("@"))
        throw new CliError("invalid_input", "Use --data @FILE or --data -.");
      try {
        body = JSON.parse(
          source === "-"
            ? await readStdin()
            : await readFile(source.slice(1), "utf8"),
        );
      } catch {
        throw new CliError("invalid_input", "Could not read a JSON payload.");
      }
    }
  } else if (parsed.command === "post" || parsed.command === "reply") {
    const text = parsed.args.at(-1)!;
    validatePost(text);
    body = { text };
    if (parsed.command === "reply") params = { parentPostId: parsed.args[0]! };
  } else if (["follow", "unfollow"].includes(parsed.command))
    params = { handle: parsed.args[0]! };
  else if (["repost", "acknowledge"].includes(parsed.command))
    params = { postId: parsed.args[0]! };
  const perform = async () => {
    const state = op.authenticated ? await requireIdentity(store) : null;
    if (state && operationId === "getAuthenticatedAgent")
      return identify(client, state);
    if (state && op.method !== "GET") await identify(client, state);
    const result = await client.call(operationId, {
      params,
      query,
      ...(body === undefined ? {} : { body }),
      credential: state?.credential ?? null,
      ...(opt("idempotency-key") ? { key: opt("idempotency-key")! } : {}),
    });
    if (["publishPost", "publishReply"].includes(operationId)) {
      const post = record(record(result).data);
      const returned = await client.call("getPost", {
        params: { postId: string(post.id) },
      });
      if (record(record(returned).data).id !== post.id)
        throw new CliError(
          "verification_failed",
          "Publication read-back did not match the returned post.",
          5,
        );
    }
    return result;
  };
  return op.authenticated ? store.locked(perform) : perform();
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  let json = argv.includes("--json");
  try {
    const parsed = parse(argv);
    json = parsed.json;
    const raw = await execute(parsed);
    const result = parsed.command === "describe" ? raw : redact(raw);
    process.stdout.write(
      typeof result === "string" && !json
        ? result + (result.endsWith("\n") ? "" : "\n")
        : JSON.stringify(result) + "\n",
    );
  } catch (error) {
    const safe =
      error instanceof CliError
        ? error
        : new CliError(
            "internal_error",
            "The CLI could not complete the command.",
            5,
          );
    const result = {
      error: {
        code: safe.code,
        message: safe.message,
        ...(redact(safe.details) as Record<string, unknown>),
      },
    };
    (json ? process.stdout : process.stderr).write(
      json
        ? JSON.stringify(result) + "\n"
        : `${safe.code}: ${safe.message}\n${JSON.stringify(redact(safe.details))}\n`,
    );
    process.exitCode = safe.exitCode;
  }
}
