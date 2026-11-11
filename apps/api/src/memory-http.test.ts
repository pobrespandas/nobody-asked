import { expect, it, vi } from "vitest";
import { handleAgentMemory } from "./memory-http.js";
import {
  PrivateAgentError,
  type AgentMemoryOperations,
} from "@nobody-asked/persistence";
const caller = {
  agentId: "agent",
  credentialId: "credential",
  token: "credential.secret",
  at: new Date(),
};
const metadata = {
  key: "context",
  version: "v1",
  createdAt: "2026-11-11T12:00:00Z",
  updatedAt: "2026-11-11T12:00:00Z",
  bytes: 4,
};
const operations: AgentMemoryOperations = {
  list: vi.fn(async () => ({ items: [metadata], nextCursor: null })),
  get: vi.fn(async () => ({ ...metadata, text: "body" })),
  put: vi.fn(async () => ({ metadata, created: true })),
  delete: vi.fn(async () => ({
    key: "context",
    deleted: true as const,
    version: "deleted-v1",
  })),
  export: vi.fn(async () => ({
    format: "nobody-asked.private-memory" as const,
    formatVersion: 1 as const,
    agentId: "agent",
    exportedAt: "2026-11-11T12:00:00Z",
    notes: [{ ...metadata, text: "body" }],
  })),
};
const put = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://network.test/v1/me/memory/context", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-None-Match": "*",
      "Idempotency-Key": "create",
      ...headers,
    },
    body: JSON.stringify(body),
  });
it("requires explicit create/replace conditions and rejects extra fields", async () => {
  expect(
    (
      await handleAgentMemory(
        operations,
        put({ text: "body", owner: "other" }),
        caller,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAgentMemory(
        operations,
        put({ text: "body" }, { "If-Match": '"v1"' }),
        caller,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAgentMemory(
        operations,
        put({ text: "body" }, { "If-None-Match": "" }),
        caller,
      )
    ).status,
  ).toBe(400);
});
it("keeps metadata and reads in private no-store responses", async () => {
  const created = await handleAgentMemory(
    operations,
    put({ text: "body" }),
    caller,
  );
  expect(created.status).toBe(201);
  expect(created.headers.get("etag")).toBe('"v1"');
  expect(created.headers.get("cache-control")).toBe("private, no-store");
  expect(JSON.stringify(await created.json())).not.toContain('"text"');
  const read = await handleAgentMemory(
    operations,
    new Request("https://network.test/v1/me/memory/context"),
    caller,
  );
  expect((await read.json()).data.text).toBe("body");
  expect(read.headers.get("x-robots-tag")).toBe("noindex, nofollow");
});
it("rejects repeated filters, oversized input and malformed UTF-8 without reflecting text", async () => {
  expect(
    (
      await handleAgentMemory(
        operations,
        new Request("https://network.test/v1/me/memory?limit=1&limit=2"),
        caller,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAgentMemory(
        operations,
        put({ text: "x".repeat(70000) }),
        caller,
      )
    ).status,
  ).toBe(413);
  const invalid = new Request("https://network.test/v1/me/memory/context", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "If-None-Match": "*",
      "Idempotency-Key": "create",
    },
    body: new Uint8Array([0xff]),
  });
  expect((await handleAgentMemory(operations, invalid, caller)).status).toBe(
    400,
  );
});
it("explains an accepted deletion retry without exposing note content", async () => {
  const failing = {
    ...operations,
    delete: async () => {
      throw new PrivateAgentError(503, "memory_deletion_pending");
    },
  };
  const response = await handleAgentMemory(
    failing,
    new Request("https://network.test/v1/me/memory/context", {
      method: "DELETE",
      headers: { "If-Match": '"v1"', "Idempotency-Key": "delete" },
    }),
    caller,
  );
  expect(response.status).toBe(503);
  expect((await response.json()).error.recovery).toMatchObject({
    action: "retry_same_request",
    preserveIdempotencyKey: true,
  });
});
