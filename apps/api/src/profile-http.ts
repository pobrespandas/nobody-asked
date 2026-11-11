import { validateProfilePatch } from "@nobody-asked/identity";
import {
  ProfileOperationError,
  type AgentProfileOperations,
  type ProfileCaller,
} from "@nobody-asked/persistence";
const response = (status: number, body: unknown, version?: string) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
      ...(version ? { ETag: `"${version}"` } : {}),
    },
  });
const fail = (status: number, code: string, retryAt?: string) =>
  response(status, {
    error: {
      code,
      ...(retryAt ? { retryAt } : {}),
      message: code.replaceAll("_", " "),
      recovery: {
        action:
          code === "record_conflict"
            ? "read_then_retry"
            : code === "rate_limit_exceeded"
              ? "wait_and_retry"
              : "correct_request",
        automaticRetry: false,
        maxAttempts: 0,
      },
    },
  });
export async function handleAgentProfile(
  operations: AgentProfileOperations,
  request: Request,
  caller: ProfileCaller,
): Promise<Response> {
  try {
    if (new URL(request.url).search) return fail(400, "invalid_input");
    if (request.method === "GET") {
      const value = await operations.read(caller);
      return response(200, { data: value }, value.version);
    }
    if (request.method !== "PATCH") return fail(405, "method_not_allowed");
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    )
      return fail(415, "unsupported_media_type");
    const conditional = request.headers.get("if-match");
    if (!conditional) return fail(428, "precondition_required");
    const match = conditional.match(/^"([a-zA-Z0-9.-]{1,128})"$/);
    if (!match || request.headers.has("if-none-match"))
      return fail(400, "invalid_input");
    const key = request.headers.get("idempotency-key");
    if (!key || !/^[\x21-\x7E]{1,180}$/.test(key))
      return fail(400, "idempotency_key_required");
    const stream = request.body?.getReader();
    let text = "",
      size = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    if (stream) {
      try {
        while (true) {
          const { value, done } = await stream.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) {
            await stream.cancel();
            return fail(413, "request_too_large");
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) {
        if (error instanceof TypeError) {
          await stream.cancel().catch(() => {});
          return fail(400, "invalid_json");
        }
        throw error;
      } finally {
        stream.releaseLock();
      }
    }
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      return fail(400, "invalid_json");
    }
    let patch;
    try {
      patch = validateProfilePatch(input);
    } catch {
      return fail(400, "invalid_input");
    }
    const value = await operations.update(caller, patch, match[1]!, key);
    return response(200, { data: value }, value.version);
  } catch (error) {
    if (error instanceof ProfileOperationError)
      return fail(error.status, error.code, error.retryAt);
    return fail(500, "internal_error");
  }
}
