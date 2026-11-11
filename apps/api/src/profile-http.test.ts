import { expect, it, vi } from "vitest";
import { handleAgentProfile } from "./profile-http.js";
import {
  ProfileOperationError,
  type AgentProfileOperations,
} from "@nobody-asked/persistence";
const snapshot = {
  profile: { id: "agent", displayName: "Lina", description: null },
  version: "v1",
};
const caller = {
  agentId: "agent",
  credentialId: "credential",
  token: "credential.secret",
  at: new Date(),
};
const operations: AgentProfileOperations = {
  read: vi.fn(async () => snapshot),
  update: vi.fn(async () => snapshot),
};
const request = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://example.test/v1/me/profile", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "If-Match": '"v1"',
      "Idempotency-Key": "change-name",
      ...headers,
    },
    body: JSON.stringify(body),
  });
it("requires a conditional change and rejects identity/status fields", async () => {
  expect(
    (await handleAgentProfile(operations, request({ handle: "other" }), caller))
      .status,
  ).toBe(400);
  expect(
    (
      await handleAgentProfile(
        operations,
        request({ status: "active" }),
        caller,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAgentProfile(
        operations,
        request({ displayName: "Lina" }, { "If-Match": "" }),
        caller,
      )
    ).status,
  ).toBe(428);
});
it("returns private no-store responses and a reusable quoted ETag", async () => {
  const r = await handleAgentProfile(
    operations,
    request({ description: "  Biography  " }),
    caller,
  );
  expect(r.status).toBe(200);
  expect(r.headers.get("etag")).toBe('"v1"');
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(operations.update).toHaveBeenCalledWith(
    caller,
    { description: "Biography" },
    "v1",
    "change-name",
  );
});
it("keeps conflicts recoverable and never reflects input text", async () => {
  const failing = {
    ...operations,
    update: async () => {
      throw new ProfileOperationError(409, "record_conflict");
    },
  };
  const r = await handleAgentProfile(
    failing,
    request({ description: "private input" }),
    caller,
  );
  expect(r.status).toBe(409);
  const text = await r.text();
  expect(text).toContain("read_then_retry");
  expect(text).not.toContain("private input");
});
it("limits streamed input and validates Unicode code points", async () => {
  expect(
    (
      await handleAgentProfile(
        operations,
        request({ description: "x".repeat(70000) }),
        caller,
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await handleAgentProfile(
        operations,
        request({ displayName: "😀".repeat(80) }),
        caller,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await handleAgentProfile(
        operations,
        request({ displayName: "😀".repeat(81) }),
        caller,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAgentProfile(
        operations,
        request({ description: "x".repeat(513) }),
        caller,
      )
    ).status,
  ).toBe(400);
});
it("rejects malformed and truncated UTF-8 as private client errors", async () => {
  for (const body of [new Uint8Array([0xff]), new Uint8Array([0xe2, 0x82])]) {
    const malformed = new Request("https://example.test/v1/me/profile", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "If-Match": '"v1"',
        "Idempotency-Key": "malformed-body",
      },
      body,
    });
    const result = await handleAgentProfile(operations, malformed, caller);
    expect(result.status).toBe(400);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await result.json()).error.code).toBe("invalid_json");
  }
});
