import { expect, it, vi } from "vitest";
import { handleAgentInbox } from "./inbox-http.js";
import {
  InboxHistoryGapError,
  type AgentInboxOperations,
  type ProfileCaller,
} from "@nobody-asked/persistence";
const caller: ProfileCaller = {
  agentId: "agent",
  credentialId: "credential",
  token: "credential.secret",
  at: new Date(),
};
const page = {
  data: [],
  page: {
    nextCursor: null,
    highWaterMark: 0,
    lastSeenPosition: 0,
    oldestRetainedPosition: 0,
    seenThrough: "seen",
  },
};
const operations: AgentInboxOperations = {
  list: vi.fn(async () => page),
  seen: vi.fn(async () => ({ lastSeenPosition: 1 })),
};
it("does not acknowledge an inbox while reading it", async () => {
  const result = await handleAgentInbox(
    operations,
    new Request("https://network.test/v1/me/inbox?limit=25"),
    caller,
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(await result.json()).toEqual(page);
  expect(operations.seen).not.toHaveBeenCalled();
});
it("rejects unknown and repeated query fields", async () => {
  expect(
    (
      await handleAgentInbox(
        operations,
        new Request("https://network.test/v1/me/inbox?agentId=other"),
        caller,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handleAgentInbox(
        operations,
        new Request("https://network.test/v1/me/inbox?cursor=a&cursor=b"),
        caller,
      )
    ).status,
  ).toBe(400);
});
it("requires an explicit bounded seen command", async () => {
  const request = (body: unknown) =>
    new Request("https://network.test/v1/me/inbox/seen", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "seen-page",
      },
      body: JSON.stringify(body),
    });
  expect(
    (await handleAgentInbox(operations, request({ through: 4 }), caller))
      .status,
  ).toBe(400);
  expect(
    (
      await handleAgentInbox(
        operations,
        request({ through: "seen", agentId: "other" }),
        caller,
      )
    ).status,
  ).toBe(400);
  const result = await handleAgentInbox(
    operations,
    request({ through: "seen" }),
    caller,
  );
  expect(result.status).toBe(200);
  expect(operations.seen).toHaveBeenCalledWith(caller, "seen", "seen-page");
  expect(
    (
      await handleAgentInbox(
        operations,
        request({ through: "x".repeat(9000) }),
        caller,
      )
    ).status,
  ).toBe(413);
});
it("returns explicit recovery for expired history", async () => {
  const failing = {
    ...operations,
    list: async () => {
      throw new InboxHistoryGapError(12, "restart");
    },
  };
  const result = await handleAgentInbox(
    failing,
    new Request("https://network.test/v1/me/inbox"),
    caller,
  );
  expect(result.status).toBe(410);
  expect((await result.json()).error.recovery).toMatchObject({
    action: "restart_inbox",
    restartCursor: "restart",
    oldestRetainedPosition: 12,
  });
});
