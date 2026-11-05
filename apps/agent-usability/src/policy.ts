/** Limits apply in the host process, outside the Agent workspace. */
export class ExperimentBudget {
  private requests = 0;
  private sessions = 0;
  readonly deadline: number;

  constructor(
    private readonly now: () => number = Date.now,
    readonly maximumRequests = 100,
    durationMs = 600_000,
  ) {
    this.deadline = now() + durationMs;
  }

  assertActive(): void {
    if (this.now() >= this.deadline)
      throw new Error("Experiment deadline reached.");
  }

  request(): void {
    this.assertActive();
    if (this.requests >= this.maximumRequests)
      throw new Error("Network request limit reached.");
    this.requests++;
  }

  startSession(): void {
    this.assertActive();
    if (this.sessions >= 2) throw new Error("SDK session limit reached.");
    this.sessions++;
  }

  snapshot(): { requests: number; sessions: number } {
    return { requests: this.requests, sessions: this.sessions };
  }
}

export function publicUrl(value: string, origin: string): URL {
  const url = new URL(value);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.protocol !== "https:"
  )
    throw new Error("Only the approved public HTTPS origin is available.");
  return url;
}

export interface NetworkIntent {
  url: string;
  method: string;
  digest?: string;
  idempotencyKey?: string;
  recoveryOperation?: string;
}

export class NetworkPolicy {
  private writes = new Map<string, string>();
  constructor(
    readonly origin: string,
    readonly budget: ExperimentBudget,
  ) {}

  allow(intent: NetworkIntent): void {
    const url = publicUrl(intent.url, this.origin);
    let slot: string | undefined;
    if (intent.method !== "GET") {
      if (intent.method !== "POST")
        throw new Error("Method is outside the experiment.");
      const path = url.pathname;
      if (path === "/v1/agent-registrations") slot = "registration-start";
      else if (/^\/v1\/agent-registrations\/[^/]+\/complete$/.test(path))
        slot = "registration-complete";
      else if (path === "/v1/posts") slot = "post";
      else if (/^\/v1\/posts\/[^/]+\/replies$/.test(path)) slot = "reply";
      else if (
        /^\/v1\/agents\/[^/]+\/recovery-challenges(?:\/[^/]+\/complete)?$/.test(
          path,
        )
      ) {
        if (
          !["replace_credential", "stop_agent"].includes(
            intent.recoveryOperation ?? "",
          )
        )
          throw new Error("Recovery operation is outside the experiment.");
      } else {
        throw new Error("Write route is outside the experiment.");
      }
      if (slot) {
        // Only an exact idempotent replay can reuse a publication slot.
        const fingerprint =
          intent.idempotencyKey && intent.digest
            ? `${intent.url}:${intent.idempotencyKey}:${intent.digest}`
            : undefined;
        const previous = this.writes.get(slot);
        if (
          previous !== undefined &&
          (!fingerprint || fingerprint !== previous)
        )
          throw new Error(`Experiment ${slot} limit reached.`);
        this.budget.assertActive();
        if (previous === undefined)
          this.writes.set(slot, fingerprint ?? "used");
      }
    }
    this.budget.request();
  }
}

const commands = new Set([
  "help",
  "context",
  "describe",
  "register",
  "whoami",
  "timeline",
  "feed",
  "post",
  "reply",
  "export",
  "recover",
  "stop",
]);

/** Do not invoke a shell or permit user-selected files, profiles, or origins. */
export function cliArguments(argv: string[]): string[] {
  if (
    argv.length > 50 ||
    argv.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 4096 ||
        value.includes("\0"),
    )
  )
    throw new Error("Invalid command arguments.");
  const [runner, ...invocation] = argv;
  if (runner === "nobodyasked")
    return cliArguments([
      "npx",
      "@pobrespandas/nobodyasked@0.1.1",
      ...invocation,
    ]);
  while (
    ["--yes", "--loglevel=error", "--no-install"].includes(invocation[0] ?? "")
  )
    invocation.shift();
  const [packageName, ...args] = invocation;
  if (runner !== "npx" || packageName !== "@pobrespandas/nobodyasked@0.1.1")
    throw new Error("Only the verified pinned CLI is available.");
  if (args.length && args[0] !== "--help" && !commands.has(args[0]!))
    throw new Error("This command is outside the experiment.");
  const allowedFlags = new Set([
    "--help",
    "--json",
    "--handle",
    "--name",
    "--description",
    "--limit",
    "--cursor",
    "--idempotency-key",
    "--operation",
    "--agent-id",
    "--if-revision",
  ]);
  for (const value of args) {
    if (value === "--" || (value.startsWith("--") && !allowedFlags.has(value)))
      throw new Error("This option is outside the experiment.");
  }
  if (args[0] === "recover") {
    const operation = args.indexOf("--operation");
    if (operation >= 0 && args[operation + 1] !== "replace_credential")
      throw new Error("Only Credential recovery is in this experiment.");
  }
  return [...args];
}
