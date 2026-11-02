import {
  countPostCharacters,
  POST_TEXT_LIMIT,
  PostTextTooLongError,
  publishPost,
  type AgentId,
  type PostId,
} from "@nobody-asked/publishing";
import { InvalidFeedCursorError } from "@nobody-asked/feeds";
import { RateLimitExceededError } from "@nobody-asked/persistence";
import { describe, expect, it, vi } from "vitest";

import { createApi } from "./server.js";
import type {
  ApiDependencies,
  ApiStore,
  ApiTransaction,
  IdempotencyRecord,
  PublicPost,
} from "./types.js";

const at = new Date("2026-11-01T12:00:00.000Z");
const agentId = "agent-1" as AgentId;

function harness() {
  const posts: PublicPost[] = [];
  const records = new Map<string, IdempotencyRecord>();
  const calls: string[] = [];
  let sequence = 0;
  let monotonicTime = 0;
  const operationalRecords: unknown[] = [];
  const readiness = vi.fn(async () => {});
  const safety = vi.fn(async () => calls.push("safety"));
  const transaction: ApiTransaction = {
    findIdempotencyRecord: async (actor, route, key) =>
      records.get(`${actor}:${route}:${key}`) ?? null,
    insertPost: async (post) => {
      calls.push("write");
      posts.push({
        ...post,
        authorHandle: "observer",
        authorDisplayName: "Observer",
        acknowledgementTotal: 0,
      });
    },
    appendAudit: async () => {
      calls.push("audit");
    },
    saveIdempotencyRecord: async (record) => {
      calls.push("idempotency");
      records.set(`${record.agentId}:${record.route}:${record.key}`, record);
    },
  };
  const store: ApiStore = {
    listVisiblePublicPosts: async () => posts,
    listPublicTimelinePage: async ({ limit, cursor }) => {
      const page = readTestPage(posts, limit, cursor);
      return page;
    },
    findPublicAgentByHandle: async (handle) =>
      handle === "observer"
        ? {
            id: agentId,
            handle,
            displayName: "Observer",
            description: null,
            status: "active",
            createdAt: at,
            updatedAt: at,
          }
        : null,
    findVisiblePublicPostById: async (id) =>
      posts.find((post) => post.id === id) ?? null,
    listVisibleConversation: async (rootId) =>
      posts.filter((post) => post.conversationRootId === rootId),
    listVisiblePublicPostsByAgent: async (id) =>
      posts.filter((post) => post.authorId === id),
    listFollowing: async () => [],
    listFollowers: async () => [],
    publishPostIdempotently: async (input) => {
      const existing = await transaction.findIdempotencyRecord(
        input.authenticatedAgentId,
        "POST /v1/posts",
        input.idempotencyKey,
      );
      if (existing) {
        if (existing.requestFingerprint !== input.requestFingerprint) {
          throw Object.assign(new Error("conflict"), {
            code: "idempotency_conflict",
          });
        }
        return { kind: "replay", response: existing.response };
      }
      await safety();
      const post = publishPost(
        {
          nextPostId: () => `post-${++sequence}` as PostId,
          now: () => input.occurredAt,
        },
        { authorId: input.authenticatedAgentId, text: input.text },
      );
      const response = {
        status: 201,
        body: {
          data: {
            ...post,
            publishedAt: post.publishedAt.toISOString(),
          },
        },
      };
      await transaction.insertPost(post);
      await transaction.appendAudit({
        actorAgentId: input.authenticatedAgentId,
        action: "post.published",
        subjectPostId: post.id,
        occurredAt: input.occurredAt,
        correlationId: input.correlationId,
      });
      await transaction.saveIdempotencyRecord({
        agentId: input.authenticatedAgentId,
        route: "POST /v1/posts",
        key: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
        response,
      });
      return { kind: "created", post, response };
    },
    publishReplyIdempotently: async (input) => {
      await safety();
      const count = countPostCharacters(input.text);
      if (count > POST_TEXT_LIMIT) throw new PostTextTooLongError(count);
      const parent = posts.find(
        (candidate) => candidate.id === input.parentPostId,
      );
      if (!parent) {
        throw Object.assign(new Error("missing"), { code: "post_not_found" });
      }
      const reply = {
        id: `post-${++sequence}` as PostId,
        authorId: input.authenticatedAgentId,
        text: input.text,
        publishedAt: input.occurredAt,
        parentId: parent.id,
        conversationRootId: parent.conversationRootId,
      };
      posts.push({
        ...reply,
        authorHandle: "observer",
        authorDisplayName: "Observer",
        acknowledgementTotal: 0,
      });
      return {
        kind: "created",
        post: reply,
        response: {
          status: 201,
          body: {
            data: {
              ...reply,
              publishedAt: reply.publishedAt.toISOString(),
            },
          },
        },
      };
    },
  };
  const dependencies: ApiDependencies = {
    authenticator: {
      authenticate: vi.fn(async (secret) =>
        secret === "valid-secret"
          ? { agentId, credentialId: "credential-1" }
          : null,
      ),
    },
    store,
    nextCorrelationId: () => "correlation-1",
    now: () => new Date(at),
    readiness: { check: readiness },
    operationalLogger: {
      write: (record) => operationalRecords.push(record),
    },
    monotonicNow: () => monotonicTime++,
  };
  return {
    api: createApi(dependencies),
    calls,
    dependencies,
    posts,
    safety,
    readiness,
    operationalRecords,
  };
}

function readTestPage(
  posts: readonly PublicPost[],
  limit: number,
  cursor?: string | null,
) {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset)) {
    throw new InvalidFeedCursorError();
  }
  const items = [...posts].reverse().slice(offset, offset + limit);
  return {
    items,
    nextCursor:
      offset + items.length < posts.length ? String(offset + limit) : null,
  };
}

function post(text: string, key = "request-1", extra: object = {}) {
  return new Request("https://network.test/v1/posts", {
    method: "POST",
    headers: {
      authorization: "Bearer valid-secret",
      "idempotency-key": key,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text, ...extra }),
  });
}

function reply(parentId: string, text: string, key = "reply-1") {
  return new Request(
    `https://network.test/v1/posts/${encodeURIComponent(parentId)}/replies`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer valid-secret",
        "idempotency-key": key,
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    },
  );
}

describe("POST /v1/posts", () => {
  it("uses credential identity and applies Safety before the atomic write", async () => {
    const { api, calls, posts } = harness();
    const response = await api(
      post("An observation.", "one", { authorId: "agent-2" }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: "post-1", authorId: agentId },
    });
    expect(posts).toHaveLength(1);
    expect(calls).toEqual(["safety", "write", "audit", "idempotency"]);
  });

  it("replays one response without another write", async () => {
    const { api, safety, posts } = harness();
    const first = await api(post("Once."));
    const second = await api(post("Once."));

    expect(await second.json()).toEqual(await first.json());
    expect(posts).toHaveLength(1);
    expect(safety).toHaveBeenCalledOnce();
  });

  it("locks and checks idempotency before it reserves a public ID", async () => {
    const { api } = harness();
    await api(post("Once.", "same"));
    await api(post("Once.", "same"));
    const next = await api(post("Next.", "next"));

    await expect(next.json()).resolves.toMatchObject({
      data: { id: "post-2" },
    });
  });

  it("rejects the same key with different input", async () => {
    const { api } = harness();
    await api(post("First."));
    const response = await api(post("Second."));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    });
  });

  it("returns stable authentication and domain errors", async () => {
    const { api } = harness();
    const noAuth = new Request("https://network.test/v1/posts", {
      method: "POST",
      body: JSON.stringify({ text: "No." }),
    });
    const unauthorized = await api(noAuth);
    const tooLong = await api(post("x".repeat(129)));

    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toMatchObject({
      error: { code: "authentication_required" },
    });
    expect(tooLong.status).toBe(422);
    await expect(tooLong.json()).resolves.toMatchObject({
      error: { code: "post_text_too_long" },
    });
  });

  it("does not write when Safety denies the action", async () => {
    const { api, safety, posts } = harness();
    const denial = Object.assign(new Error("The agent is suspended."), {
      code: "agent_suspended",
    });
    safety.mockRejectedValue(denial);

    const response = await api(post("Blocked."));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "agent_suspended" },
    });
    expect(posts).toHaveLength(0);
  });

  it("returns a stable rate-limit error and retry time", async () => {
    const { api, dependencies } = harness();
    vi.spyOn(dependencies.store, "publishPostIdempotently").mockRejectedValue(
      new RateLimitExceededError(new Date("2026-11-01T12:01:00.000Z")),
    );

    const response = await api(post("Too soon."));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "The action limit was reached.",
        retryAt: "2026-11-01T12:01:00.000Z",
      },
    });
  });

  it("does not expose database or unknown coded errors", async () => {
    const { api, safety } = harness();
    const databaseError = Object.assign(
      new Error("duplicate key value violates secret_table_constraint"),
      { code: "23505", detail: "credential_digest=private" },
    );
    safety.mockRejectedValue(databaseError);

    const response = await api(post("Hidden failure."));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).toBe(
      JSON.stringify({
        error: {
          code: "internal_error",
          message: "The request could not be completed.",
        },
      }),
    );
    expect(serialized).not.toMatch(/23505|credential|constraint|private/i);
  });
});

describe("POST /v1/posts/{parentPostId}/replies", () => {
  it("preserves the direct parent and conversation root", async () => {
    const { api } = harness();
    const root = await api(post("Root.", "root"));
    const rootId = String(
      ((await root.json()) as { data: { id: string } }).data.id,
    );
    const first = await api(reply(rootId, "First.", "first"));
    const firstBody = (await first.json()) as { data: { id: string } };
    const nested = await api(reply(firstBody.data.id, "Nested.", "nested"));

    expect(first.status).toBe(201);
    await expect(nested.json()).resolves.toMatchObject({
      data: { parentId: firstBody.data.id, conversationRootId: rootId },
    });
  });

  it("returns stable errors for a missing parent and long text", async () => {
    const { api } = harness();
    const missing = await api(reply("missing", "No parent."));
    const root = await api(post("Root.", "root"));
    const rootId = String(
      ((await root.json()) as { data: { id: string } }).data.id,
    );
    const tooLong = await api(reply(rootId, "x".repeat(129), "long"));

    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "post_not_found" },
    });
    expect(tooLong.status).toBe(422);
    await expect(tooLong.json()).resolves.toMatchObject({
      error: { code: "post_text_too_long" },
    });
  });
});

describe("operational endpoints and logs", () => {
  it("reports readiness without reading application records", async () => {
    const { api, readiness, dependencies } = harness();
    const readSpies = [
      vi.spyOn(dependencies.store, "listVisiblePublicPosts"),
      vi.spyOn(dependencies.store, "listPublicTimelinePage"),
      vi.spyOn(dependencies.store, "findPublicAgentByHandle"),
      vi.spyOn(dependencies.store, "findVisiblePublicPostById"),
    ];

    const response = await api(
      new Request("https://network.test/health/ready"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expect(readiness).toHaveBeenCalledOnce();
    for (const read of readSpies) expect(read).not.toHaveBeenCalled();
  });

  it("fails readiness closed without exposing the cause", async () => {
    const { api, readiness, operationalRecords } = harness();
    readiness.mockRejectedValue(
      new Error("credential digest and private moderation note"),
    );

    const response = await api(
      new Request("https://network.test/health/ready"),
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toBe(JSON.stringify({ status: "not_ready" }));
    expect(serialized).not.toMatch(/credential|moderation|digest/i);
    expect(operationalRecords).toEqual([
      {
        severity: "ERROR",
        event: "http.request.completed",
        method: "GET",
        route: "health.ready",
        status: 503,
        durationMs: 1,
      },
    ]);
  });

  it("logs only route templates and response facts", async () => {
    const { api, operationalRecords } = harness();
    const privateText = "do-not-log-this-post-body";
    const credential = "do-not-log-this-credential";
    await api(
      new Request(
        "https://network.test/v1/posts/private-post-id?internalNote=private-note",
        {
          headers: { authorization: `Bearer ${credential}` },
        },
      ),
    );
    await api(post(privateText));

    const serialized = JSON.stringify(operationalRecords);
    expect(serialized).toContain('"route":"post.read"');
    expect(serialized).toContain('"route":"post.publish"');
    expect(serialized).not.toMatch(
      /private-post-id|private-note|do-not-log|authorization|credential/i,
    );
  });
});

describe("public reads", () => {
  it("returns a public profile without authentication", async () => {
    const { api } = harness();
    const response = await api(
      new Request("https://network.test/v1/agents/observer"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { id: agentId, handle: "observer", status: "active" },
    });
  });

  it("paginates visible posts with a stable opaque cursor", async () => {
    const { api } = harness();
    await api(post("First.", "one"));
    await api(post("Second.", "two"));

    const first = await api(
      new Request("https://network.test/v1/timeline?limit=1"),
    );
    const firstBody = (await first.json()) as {
      data: { id: string }[];
      page: { nextCursor: string };
    };
    const second = await api(
      new Request(
        `https://network.test/v1/timeline?limit=1&cursor=${firstBody.page.nextCursor}`,
      ),
    );
    const secondBody = (await second.json()) as { data: { id: string }[] };

    expect(firstBody.data[0]?.id).toBe("post-2");
    expect(secondBody.data[0]?.id).toBe("post-1");
  });

  it("rejects an invalid cursor with a stable error", async () => {
    const { api } = harness();
    const response = await api(
      new Request("https://network.test/v1/timeline?cursor=not%20opaque"),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "invalid_feed_cursor" },
    });
  });

  it("rejects a zero page limit on every public list", async () => {
    const { api } = harness();
    const paths = [
      "/v1/timeline",
      "/v1/agents/observer/posts",
      "/v1/agents/observer/following",
      "/v1/agents/observer/followers",
    ];

    const responses = await Promise.all(
      paths.map((path) =>
        api(new Request(`https://network.test${path}?limit=0`)),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([
      400, 400, 400, 400,
    ]);
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_feed_limit" },
      });
    }
  });
});
