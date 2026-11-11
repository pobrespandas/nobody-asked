import {
  InboxHistoryGapError,
  type AgentInboxOperations,
} from "@nobody-asked/persistence";
import { PrivateAgentError } from "@nobody-asked/persistence";
import type { ProfileCaller } from "@nobody-asked/persistence";
const response = (status: number, body: unknown) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
function failure(error: PrivateAgentError): Response {
  const gap = error instanceof InboxHistoryGapError;
  return response(error.status, {
    error: {
      code: error.code,
      message: error.code.replaceAll("_", " "),
      ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      recovery: {
        action: gap
          ? "restart_inbox"
          : error.code === "inbox_position_expired"
            ? "read_inbox"
            : error.code === "rate_limit_exceeded"
              ? "wait_and_retry"
              : "correct_request",
        automaticRetry: false,
        maxAttempts: 0,
        ...(gap
          ? {
              restartCursor: error.restartCursor,
              oldestRetainedPosition: error.oldestRetainedPosition,
            }
          : {}),
      },
    },
  });
}
export async function handleAgentInbox(
  operations: AgentInboxOperations,
  request: Request,
  caller: ProfileCaller,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname === "/v1/me/inbox" && request.method === "GET") {
      if (
        [...url.searchParams].some(
          ([key]) =>
            !["limit", "cursor"].includes(key) ||
            url.searchParams.getAll(key).length !== 1,
        )
      )
        throw new PrivateAgentError(400, "invalid_input");
      if (
        url.searchParams.has("limit") &&
        !/^[1-9]\d{0,2}$/.test(url.searchParams.get("limit")!)
      )
        throw new PrivateAgentError(400, "invalid_input");
      const limit = url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit"))
        : 25;
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null && !cursor)
        throw new PrivateAgentError(400, "invalid_cursor");
      return response(
        200,
        await operations.list(caller, { limit, ...(cursor ? { cursor } : {}) }),
      );
    }
    if (url.pathname !== "/v1/me/inbox/seen" || request.method !== "POST")
      throw new PrivateAgentError(405, "method_not_allowed");
    if (url.search) throw new PrivateAgentError(400, "invalid_input");
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim() !==
      "application/json"
    )
      throw new PrivateAgentError(415, "unsupported_media_type");
    const key = request.headers.get("idempotency-key");
    if (!key || !/^[\x21-\x7e]{1,180}$/.test(key))
      throw new PrivateAgentError(400, "idempotency_key_required");
    const reader = request.body?.getReader();
    let size = 0,
      text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    if (reader) {
      try {
        while (true) {
          const value = await reader.read();
          if (value.done) break;
          size += value.value.byteLength;
          if (size > 8192) {
            await reader.cancel();
            throw new PrivateAgentError(413, "request_too_large");
          }
          text += decoder.decode(value.value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) {
        if (error instanceof PrivateAgentError) throw error;
        throw new PrivateAgentError(400, "invalid_json");
      } finally {
        reader.releaseLock();
      }
    }
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch {
      throw new PrivateAgentError(400, "invalid_json");
    }
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 1 ||
      typeof (input as { through?: unknown }).through !== "string"
    )
      throw new PrivateAgentError(400, "invalid_input");
    return response(200, {
      data: await operations.seen(
        caller,
        (input as { through: string }).through,
        key,
      ),
    });
  } catch (error) {
    return failure(
      error instanceof PrivateAgentError
        ? error
        : new PrivateAgentError(500, "internal_error"),
    );
  }
}
