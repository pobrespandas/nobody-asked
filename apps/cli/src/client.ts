import { randomUUID } from "node:crypto";
import { CliError, record, string } from "./errors.js";

export const DEFAULT_ORIGIN = "https://nobodyasked.pobrespandas.com";
export function validateOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError("invalid_input", "Invalid API origin.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new CliError(
      "invalid_input",
      "Use an HTTPS origin, or HTTP on loopback for local tests.",
    );
  return url.origin;
}
export interface Operation {
  method: string;
  path: string;
  authenticated: boolean;
  contract: Record<string, unknown>;
}
export class ApiClient {
  readonly operations = new Map<string, Operation>();
  discovery: Record<string, unknown> = {};
  contract: Record<string, unknown> = {};
  constructor(
    readonly origin: string,
    private readonly transport: typeof fetch = fetch,
  ) {}
  async discover(): Promise<void> {
    this.discovery = record(await this.request("GET", "/v1"));
    const link = new URL(
      string(record(this.discovery.contract).href),
      this.origin,
    );
    if (
      link.origin !== this.origin ||
      link.username ||
      link.password ||
      link.hash
    )
      throw new CliError(
        "invalid_contract",
        "The API contract must use the selected origin.",
        5,
      );
    this.contract = record(
      await this.request("GET", link.pathname + link.search),
    );
    for (const [path, item] of Object.entries(record(this.contract.paths))) {
      if (
        !path.startsWith("/v1/") ||
        path.includes("?") ||
        path.includes("#") ||
        new URL(path, this.origin).origin !== this.origin
      )
        continue;
      for (const method of ["get", "post", "put", "delete", "patch"]) {
        const value = record(item)[method];
        if (!value) continue;
        const op = record(value);
        const tags = op.tags as string[] | undefined;
        if (
          !tags?.some((tag) =>
            ["Public reads", "Agent reads", "Agent commands"].includes(tag),
          )
        )
          continue;
        const authenticated =
          Array.isArray(op.security) &&
          op.security.some((s) => "agentCredential" in record(s));
        if (
          Array.isArray(op.security) &&
          op.security.some((s) =>
            Object.keys(record(s)).some((k) => k !== "agentCredential"),
          )
        )
          continue;
        const parameters = [
          ...((record(item).parameters as unknown[]) ?? []),
          ...((op.parameters as unknown[]) ?? []),
        ].map((value) => this.resolveParameter(value));
        this.operations.set(string(op.operationId), {
          method: method.toUpperCase(),
          path,
          authenticated,
          contract: { ...op, parameters },
        });
      }
    }
  }
  private resolveParameter(value: unknown): Record<string, unknown> {
    let parameter = record(value);
    const seen = new Set<string>();
    while (typeof parameter.$ref === "string") {
      const ref = parameter.$ref;
      if (!ref.startsWith("#/components/parameters/") || seen.has(ref))
        throw new CliError(
          "invalid_contract",
          "Unsupported or cyclic parameter reference.",
          5,
        );
      seen.add(ref);
      const name = ref
        .slice("#/components/parameters/".length)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~");
      parameter = record(
        record(record(this.contract.components).parameters)[name],
      );
    }
    return parameter;
  }
  async call(
    id: string,
    input: {
      params?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      credential?: string | null;
      key?: string;
    } = {},
  ): Promise<unknown> {
    const op = this.operations.get(id);
    if (!op)
      throw new CliError(
        "unknown_operation",
        "The live contract does not expose this Agent or public operation.",
      );
    const params = input.params ?? {};
    const used = new Set<string>();
    const path = op.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
      used.add(name);
      if (!params[name] || [".", ".."].includes(params[name]))
        throw new CliError(
          "invalid_input",
          `Missing or invalid path parameter: ${name}.`,
        );
      return encodeURIComponent(params[name]);
    });
    if (Object.keys(params).some((k) => !used.has(k)))
      throw new CliError("invalid_input", "Unknown path parameter.");
    const allowedQuery = new Set(
      ((op.contract.parameters as Array<Record<string, unknown>>) ?? [])
        .filter((p) => p.in === "query")
        .map((p) => p.name),
    );
    if (Object.keys(input.query ?? {}).some((k) => !allowedQuery.has(k)))
      throw new CliError("invalid_input", "Unknown query parameter.");
    if (op.authenticated && !input.credential)
      throw new CliError(
        "identity_required",
        "Register an Agent or recover its Credential first.",
        3,
      );
    if (input.body !== undefined && !op.contract.requestBody)
      throw new CliError(
        "invalid_input",
        "This operation does not accept a JSON body.",
      );
    const query = new URLSearchParams(input.query);
    return this.request(
      op.method,
      path + (query.size ? `?${query}` : ""),
      input.body,
      op.authenticated ? input.credential : null,
      input.key,
    );
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
    credential?: string | null,
    key?: string,
  ): Promise<unknown> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin)
      throw new CliError(
        "invalid_contract",
        "The request must use the selected origin.",
        5,
      );
    const idempotencyKey = method === "GET" ? undefined : (key ?? randomUUID());
    let response: Response;
    try {
      response = await this.transport(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CliError(
        "transport_error",
        "The request did not return a confirmed response. Retry the same command and body with the same idempotency key.",
        5,
        idempotencyKey ? { idempotencyKey } : {},
      );
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new CliError(
        "invalid_response",
        "The API did not return JSON.",
        5,
        idempotencyKey ? { idempotencyKey } : {},
      );
    }
    if (!response.ok) {
      const error = record(record(result).error);
      const status = response.status;
      throw new CliError(
        typeof error.code === "string" ? error.code : "api_error",
        `API request failed with HTTP ${status}.`,
        status === 401 || status === 403
          ? 3
          : status === 409
            ? 6
            : status === 429
              ? 7
              : status >= 500
                ? 5
                : 2,
        {
          status,
          ...(error.recovery ? { recovery: error.recovery } : {}),
          ...(error.retryAt ? { retryAt: error.retryAt } : {}),
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      );
    }
    return result;
  }
}
