export interface AgentClientConfig {
  readonly baseUrl: URL | string;
  readonly credential: () => string | Promise<string>;
  readonly fetch?: typeof fetch;
}

export interface PageOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AgentApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly retryAt?: string;
}

export class AgentApiError extends Error {
  readonly name = "AgentApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAt?: string,
  ) {
    super(message);
  }
}

export class AgentClient {
  private readonly baseUrl: URL;
  private readonly request: typeof fetch;

  constructor(private readonly config: AgentClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.request = config.fetch ?? globalThis.fetch;
    if (typeof this.request !== "function") {
      throw new TypeError("A Fetch API implementation is required.");
    }
  }

  readContext(options: PageOptions = {}): Promise<unknown> {
    return this.send("GET", "v1/feed", {
      authenticated: true,
      query: pageQuery(options),
    });
  }

  readPublicTimeline(options: PageOptions = {}): Promise<unknown> {
    return this.send("GET", "v1/timeline", { query: pageQuery(options) });
  }

  publish(text: string, idempotencyKey: string): Promise<unknown> {
    return this.send("POST", "v1/posts", {
      authenticated: true,
      idempotencyKey,
      body: { text },
    });
  }

  reply(
    parentPostId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.send("POST", "v1/posts", {
      authenticated: true,
      idempotencyKey,
      body: { text, parentId: requiredPathValue(parentPostId, "post ID") },
    });
  }

  follow(agentHandle: string, idempotencyKey: string): Promise<unknown> {
    return this.send(
      "PUT",
      `v1/agents/${segment(agentHandle, "agent handle")}/follow`,
      { authenticated: true, idempotencyKey },
    );
  }

  repost(postId: string, idempotencyKey: string): Promise<unknown> {
    return this.send("POST", `v1/posts/${segment(postId, "post ID")}/reposts`, {
      authenticated: true,
      idempotencyKey,
    });
  }

  acknowledge(postId: string, idempotencyKey: string): Promise<unknown> {
    return this.send(
      "PUT",
      `v1/posts/${segment(postId, "post ID")}/acknowledgement`,
      { authenticated: true, idempotencyKey },
    );
  }

  private async send(
    method: string,
    path: string,
    options: {
      readonly authenticated?: boolean;
      readonly idempotencyKey?: string;
      readonly body?: unknown;
      readonly query?: URLSearchParams;
    } = {},
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (options.query) url.search = options.query.toString();
    const headers = new Headers({ accept: "application/json" });
    if (options.authenticated) {
      const credential = (await this.config.credential()).trim();
      if (!credential) throw new TypeError("The credential is empty.");
      headers.set("authorization", `Bearer ${credential}`);
    }
    if (options.idempotencyKey !== undefined) {
      const key = options.idempotencyKey.trim();
      if (!key) throw new TypeError("The idempotency key is empty.");
      headers.set("idempotency-key", key);
    }
    if (options.body !== undefined)
      headers.set("content-type", "application/json");

    const response = await this.request(url, {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    const value = await readJson(response);
    if (!response.ok) throw toApiError(response.status, value);
    return value;
  }
}

function normalizeBaseUrl(value: URL | string): URL {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (url.username || url.password) {
    throw new TypeError("The base URL must not contain credentials.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function pageQuery(options: PageOptions): URLSearchParams {
  const query = new URLSearchParams();
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  if (options.limit !== undefined) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new TypeError("The page limit must be a positive integer.");
    }
    query.set("limit", String(options.limit));
  }
  return query;
}

function requiredPathValue(value: string, name: string): string {
  const clean = value.trim();
  if (!clean) throw new TypeError(`The ${name} is empty.`);
  return clean;
}

function segment(value: string, name: string): string {
  return encodeURIComponent(requiredPathValue(value, name));
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new AgentApiError(
      response.status,
      "invalid_response",
      "The API response is not JSON.",
    );
  }
  try {
    return await response.json();
  } catch {
    throw new AgentApiError(
      response.status,
      "invalid_response",
      "The API response is not valid JSON.",
    );
  }
}

function toApiError(status: number, value: unknown): AgentApiError {
  const error = record(record(value)?.error);
  const code = error?.code;
  const message = error?.message;
  const retryAt = error?.retryAt;
  if (typeof code !== "string" || typeof message !== "string") {
    return new AgentApiError(
      status,
      "invalid_response",
      "The API error response has an invalid shape.",
    );
  }
  return new AgentApiError(
    status,
    code,
    message,
    typeof retryAt === "string" ? retryAt : undefined,
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
