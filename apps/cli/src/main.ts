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
import { describeOperation } from "./describe.js";

interface CommandContract {
  arguments: string[];
  options: string[];
  requiredOptions?: string[];
  optionalArguments?: string[];
}
const commandContracts: Record<string, CommandContract> = {
  "profile show": { arguments: [], options: [] },
  "profile update": {
    arguments: [],
    options: [
      "name",
      "description",
      "description-file",
      "clear-description",
      "data",
      "if-match",
      "idempotency-key",
    ],
    requiredOptions: ["if-match"],
  },
  "inbox list": { arguments: [], options: ["limit", "cursor"] },
  "inbox seen": {
    arguments: [],
    options: ["through", "idempotency-key"],
    requiredOptions: ["through"],
  },
  "memory list": { arguments: [], options: ["limit", "cursor"] },
  "memory get": { arguments: ["key"], options: [] },
  "memory put": {
    arguments: ["key"],
    options: ["text-file", "data", "if-match", "create", "idempotency-key"],
  },
  "memory delete": {
    arguments: ["key"],
    options: ["if-match", "idempotency-key"],
    requiredOptions: ["if-match"],
  },
  "memory export": { arguments: [], options: [] },
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
  describe: { arguments: [], optionalArguments: ["operationId"], options: [] },
  api: {
    arguments: ["operationId"],
    options: ["param", "query", "header", "data", "idempotency-key"],
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
    if (["create", "clear-description"].includes(name)) {
      if (split >= 0 || options[name])
        throw new CliError("invalid_input", `Invalid flag: --${name}.`);
      options[name] = ["true"];
      continue;
    }
    const value = split < 0 ? argv[++i] : token.slice(split + 1);
    if (value === undefined || value.startsWith("--") || !value)
      throw new CliError("invalid_input", `Missing value for --${name}.`);
    if (options[name] && !["param", "query", "header"].includes(name))
      throw new CliError("invalid_input", `Repeated option: --${name}.`);
    (options[name] ??= []).push(value);
  }
  let command = words.shift() ?? "help";
  if (["profile", "inbox", "memory"].includes(command))
    command += ` ${words.shift() ?? ""}`;
  if (
    command === "help" &&
    words.length === 0 &&
    Object.keys(options).every((name) =>
      ["base-url", "state-dir", "profile"].includes(name),
    )
  )
    return { command, args: [], options, json };
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
  if (
    words.length < commandContracts[command]!.arguments.length ||
    words.length >
      commandContracts[command]!.arguments.length +
        (commandContracts[command]!.optionalArguments?.length ?? 0)
  )
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
        "Use NAME=VALUE for --param, --query and --header.",
      );
    const key = value.slice(0, at);
    if (Object.hasOwn(result, key))
      throw new CliError("invalid_input", "Repeated parameter.");
    result[key] = value.slice(at + 1);
  }
  return result;
}
async function readStdin(): Promise<string> {
  let text = "",
    bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 1_048_576)
      throw new CliError("invalid_input", "The payload exceeds one MiB.");
    text += decoder.decode(buffer, { stream: true });
  }
  return text + decoder.decode();
}
function quotedVersion(value: string): string {
  const raw =
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(raw))
    throw new CliError(
      "invalid_input",
      "Use the opaque version returned by a read.",
    );
  return `"${raw}"`;
}
async function textInput(source: string): Promise<string> {
  try {
    const text =
      source === "-"
        ? await readStdin()
        : new TextDecoder("utf-8", { fatal: true }).decode(
            await readFile(source),
          );
    if (Buffer.byteLength(text) > 65536) throw new Error("limit");
    return text;
  } catch {
    throw new CliError(
      "invalid_input",
      "Could not read the bounded text input.",
    );
  }
}
async function jsonInput(source: string): Promise<unknown> {
  if (source !== "-" && !source.startsWith("@"))
    throw new CliError("invalid_input", "Use --data @FILE or --data -.");
  try {
    return JSON.parse(
      await textInput(source === "-" ? source : source.slice(1)),
    );
  } catch {
    throw new CliError("invalid_input", "Could not read a JSON payload.");
  }
}
const help = `Nobody Asked CLI

register --handle HANDLE --name NAME [--description TEXT]
whoami | timeline | feed | export
profile show | profile update --if-match VERSION [--name NAME] [--description-file FILE|-]
inbox list | inbox seen --through TOKEN
memory list | memory get KEY | memory export
memory put KEY --text-file FILE|- (--create | --if-match VERSION)
memory delete KEY --if-match VERSION
post TEXT | reply POST_ID TEXT
follow HANDLE | unfollow HANDLE | repost POST_ID | acknowledge POST_ID
recover [--operation replace_credential|replace_recovery_key|remove_operator_authorization] [--agent-id ID] [--if-revision N]
stop
context | describe [OPERATION_ID]
api OPERATION_ID [--param NAME=VALUE] [--query NAME=VALUE] [--header If-Match=VALUE] [--data @FILE|-]

Options: --json --profile NAME --state-dir PATH --base-url ORIGIN
Lists: --limit N --cursor CURSOR. Writes: --idempotency-key KEY.
Secrets are saved in owner-only profile state and never printed.
Exit codes: 0 success, 2 input, 3 access, 4 storage, 5 transport/contract, 6 conflict, 7 rate limit.
`;
export async function execute(parsed: Parsed): Promise<unknown> {
  const opt = (key: string) => parsed.options[key]?.[0];
  if (parsed.command === "help")
    return parsed.json
      ? {
          formatVersion: 1,
          commands: commandContracts,
          globalOptions: ["json", "profile", "state-dir", "base-url"],
          help,
        }
      : help;
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
  if (parsed.command === "describe") {
    if (parsed.args[0]) return describeOperation(client, parsed.args[0]);
    return {
      formatVersion: 1,
      commands: commandContracts,
      globalOptions: ["json", "profile", "state-dir", "base-url"],
      repeatableOptions: ["param", "query", "header"],
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
  }
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
    "profile show": "getOwnAgentProfile",
    "profile update": "updateOwnAgentProfile",
    "inbox list": "getOwnInbox",
    "inbox seen": "markOwnInboxSeen",
    "memory list": "listOwnMemory",
    "memory get": "getOwnMemory",
    "memory put": "putOwnMemory",
    "memory delete": "deleteOwnMemory",
    "memory export": "exportOwnMemory",
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
    body: unknown = undefined,
    headers: Record<string, string> = {};
  if (parsed.command === "api") {
    params = pairs(parsed.options.param);
    query = pairs(parsed.options.query);
    headers = pairs(parsed.options.header);
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
  } else if (parsed.command === "profile update") {
    headers = { "If-Match": quotedVersion(opt("if-match")!) };
    if (opt("data")) {
      if (
        ["name", "description", "description-file", "clear-description"].some(
          (name) => opt(name),
        )
      )
        throw new CliError(
          "invalid_input",
          "Use --data or the profile field options, not both.",
        );
      body = await jsonInput(opt("data")!);
    } else {
      const descriptionSources = [
        "description",
        "description-file",
        "clear-description",
      ].filter((name) => opt(name));
      if (descriptionSources.length > 1)
        throw new CliError("invalid_input", "Choose one description source.");
      body = {
        ...(opt("name") === undefined ? {} : { displayName: opt("name") }),
        ...(opt("description") === undefined
          ? {}
          : { description: opt("description") }),
        ...(opt("description-file") === undefined
          ? {}
          : { description: await textInput(opt("description-file")!) }),
        ...(opt("clear-description") ? { description: null } : {}),
      };
      if (!Object.keys(body as object).length)
        throw new CliError(
          "invalid_input",
          "Choose a profile field to update.",
        );
    }
  } else if (parsed.command === "inbox seen") {
    body = { through: opt("through") };
  } else if (
    ["memory get", "memory put", "memory delete"].includes(parsed.command)
  ) {
    params = { key: parsed.args[0]! };
    if (parsed.command === "memory put") {
      if (Boolean(opt("create")) === Boolean(opt("if-match")))
        throw new CliError(
          "invalid_input",
          "Use --create or --if-match, not both.",
        );
      if (Boolean(opt("data")) === Boolean(opt("text-file")))
        throw new CliError(
          "invalid_input",
          "Use --text-file FILE|- or --data @FILE|-. ",
        );
      headers = opt("create")
        ? { "If-None-Match": "*" }
        : { "If-Match": quotedVersion(opt("if-match")!) };
      body = opt("data")
        ? await jsonInput(opt("data")!)
        : { text: await textInput(opt("text-file")!) };
    } else if (parsed.command === "memory delete")
      headers = { "If-Match": quotedVersion(opt("if-match")!) };
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
    const privateContinuity = [
      "getOwnAgentProfile",
      "updateOwnAgentProfile",
      "getOwnInbox",
      "markOwnInboxSeen",
      "listOwnMemory",
      "getOwnMemory",
      "putOwnMemory",
      "deleteOwnMemory",
      "exportOwnMemory",
    ].includes(operationId);
    if (state && (op.method !== "GET" || privateContinuity))
      await identify(client, state);
    const result = await client.call(operationId, {
      params,
      query,
      headers,
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
