import {
  PrivateAgentError,
  validateMemoryKey,
  type AgentMemoryOperations,
  type ProfileCaller,
} from "@nobody-asked/persistence";
const reply = (status: number, body: unknown, version?: string) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      ...(version ? { ETag: `"${version}"` } : {}),
    },
  });
function failure(error: PrivateAgentError): Response {
  const action =
    error.code === "record_conflict"
      ? "read_then_retry"
      : error.code === "rate_limit_exceeded"
        ? "wait_and_retry"
        : error.code === "memory_deletion_pending"
          ? "retry_same_request"
          : "correct_request";
  return reply(error.status, {
    error: {
      code: error.code,
      message: error.code.replaceAll("_", " "),
      ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      recovery: {
        action,
        automaticRetry: false,
        maxAttempts: 0,
        ...(error.code === "memory_deletion_pending"
          ? { preserveIdempotencyKey: true }
          : {}),
      },
    },
  });
}
function requireHttp(
  condition: unknown,
  status: number,
  code: string,
): asserts condition {
  if (!condition) throw new PrivateAgentError(status, code);
}
function query(url: URL, allowed: string[]): void {
  requireHttp(
    [...url.searchParams.keys()].every(
      (key) =>
        allowed.includes(key) && url.searchParams.getAll(key).length === 1,
    ),
    400,
    "invalid_input",
  );
}
function version(request: Request): string {
  const raw = request.headers.get("if-match");
  requireHttp(raw, 428, "precondition_required");
  const match = raw.match(/^"([a-zA-Z0-9.-]{1,128})"$/);
  requireHttp(
    match && !request.headers.has("if-none-match"),
    400,
    "invalid_input",
  );
  return match[1]!;
}
function key(request: Request): string {
  const value = request.headers.get("idempotency-key");
  requireHttp(
    value && /^[\x21-\x7E]{1,180}$/.test(value),
    400,
    "idempotency_key_required",
  );
  return value;
}
async function input(request: Request): Promise<{ text: string }> {
  requireHttp(
    request.headers.get("content-type")?.split(";")[0]?.trim() ===
      "application/json",
    415,
    "unsupported_media_type",
  );
  const reader = request.body?.getReader();
  requireHttp(reader, 400, "invalid_json");
  let size = 0,
    text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) {
        await reader.cancel();
        throw new PrivateAgentError(413, "request_too_large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof PrivateAgentError) throw error;
    throw new PrivateAgentError(400, "invalid_json");
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PrivateAgentError(400, "invalid_json");
  }
  requireHttp(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      Object.hasOwn(value, "text") &&
      typeof (value as { text: unknown }).text === "string",
    400,
    "invalid_input",
  );
  return value as { text: string };
}
export async function handleAgentMemory(
  operations: AgentMemoryOperations,
  request: Request,
  caller: ProfileCaller,
): Promise<Response> {
  try {
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/v1/me/memory-export") {
      query(url, []);
      requireHttp(request.method === "GET", 405, "method_not_allowed");
      return reply(200, { data: await operations.export(caller) });
    }
    if (path === "/v1/me/memory") {
      query(url, ["limit", "cursor"]);
      requireHttp(request.method === "GET", 405, "method_not_allowed");
      const limit = url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : 25;
      requireHttp(
        Number.isInteger(limit) && limit >= 1 && limit <= 100,
        400,
        "invalid_input",
      );
      const page = await operations.list(caller, {
        limit,
        cursor: url.searchParams.get("cursor"),
      });
      return reply(200, {
        data: page.items,
        page: { nextCursor: page.nextCursor },
      });
    }
    const match = path.match(/^\/v1\/me\/memory\/([^/]+)$/);
    requireHttp(match, 404, "memory_note_not_found");
    query(url, []);
    let noteKey: string;
    try {
      noteKey = decodeURIComponent(match[1]!);
    } catch {
      throw new PrivateAgentError(400, "invalid_input");
    }
    validateMemoryKey(noteKey);
    if (request.method === "GET") {
      const note = await operations.get(caller, noteKey);
      return reply(200, { data: note }, note.version);
    }
    if (request.method === "PUT") {
      const create = request.headers.get("if-none-match");
      const condition =
        create !== null
          ? (requireHttp(
              create === "*" && !request.headers.has("if-match"),
              400,
              "invalid_input",
            ),
            { createOnly: true })
          : { version: version(request) };
      const idempotencyKey = key(request),
        body = await input(request);
      const result = await operations.put(
        caller,
        noteKey,
        body.text,
        condition,
        idempotencyKey,
      );
      return reply(
        result.created ? 201 : 200,
        { data: result.metadata },
        result.metadata.version,
      );
    }
    if (request.method === "DELETE") {
      requireHttp(!request.body, 400, "invalid_input");
      const result = await operations.delete(
        caller,
        noteKey,
        version(request),
        key(request),
      );
      return reply(200, { data: result }, result.version);
    }
    throw new PrivateAgentError(405, "method_not_allowed");
  } catch (error) {
    return failure(
      error instanceof PrivateAgentError
        ? error
        : new PrivateAgentError(500, "internal_error"),
    );
  }
}
