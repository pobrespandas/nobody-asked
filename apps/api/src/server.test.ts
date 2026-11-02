import { readFile } from "node:fs/promises";

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
  const changeFollow = vi.fn(
    async (input: Parameters<ApiStore["changeFollowIdempotently"]>[0]) => ({
      response: {
        status: 200,
        body: {
          data: {
            followerId: input.authenticatedAgentId,
            followedId: input.targetAgentId,
            following: input.operation === "follow",
            changed: true,
          },
        },
      },
    }),
  );
  const repostIdempotently = vi.fn(
    async (input: Parameters<ApiStore["repostIdempotently"]>[0]) => ({
      response: {
        status: 201,
        body: {
          data: {
            id: "repost-1",
            repostingAgentId: input.authenticatedAgentId,
            sourcePostId: input.sourcePostId,
            publishedAt: input.occurredAt.toISOString(),
            created: true,
          },
        },
      },
    }),
  );
  const acknowledgeIdempotently = vi.fn(
    async (input: Parameters<ApiStore["acknowledgeIdempotently"]>[0]) => ({
      response: {
        status: 201,
        body: {
          data: {
            agentId: input.authenticatedAgentId,
            postId: input.postId,
            acknowledgedAt: input.occurredAt.toISOString(),
            acknowledgementCount: 1,
            created: true,
          },
        },
      },
    }),
  );
  const runOperatorCredentialCommand = vi.fn(async () => ({ changed: true }));
  const registerOperatorAgent = vi.fn<ApiStore["registerOperatorAgent"]>(
    async (input: Parameters<ApiStore["registerOperatorAgent"]>[0]) => ({
      kind: "created" as const,
      registration: {
        agentId: "agent-new",
        credentialId: "credential-new",
        handle: input.handle,
        displayName: input.displayName,
        description: input.description,
        status: "active" as const,
        createdAt: input.occurredAt,
      },
    }),
  );
  const runOperatorAgentControl = vi.fn(
    async (input: Parameters<ApiStore["runOperatorAgentControl"]>[0]) => ({
      changed: true,
      status:
        input.operation === "stop" ? ("stopped" as const) : ("active" as const),
    }),
  );
  const exportPortableAgent = vi.fn(async () => ({
    format: "nobody-asked.agent-export" as const,
    version: 1 as const,
    exportedAt: at.toISOString(),
    agent: {
      id: agentId,
      handle: "observer",
      displayName: "Observer",
      description: null,
      status: "active" as const,
      createdAt: at.toISOString(),
      updatedAt: at.toISOString(),
    },
    publicActivity: [],
    relationships: {
      followingAgentIds: [],
      followerAgentIds: [],
      acknowledgedPostIds: [],
    },
    publicModeration: [],
    publicAuditRecords: [],
  }));
  const submitReportIdempotently = vi.fn(async () => ({
    response: {
      status: 201,
      body: {
        data: {
          id: "report-1",
          target: { type: "public_item", id: "post-1" },
          reasonCategory: "spam",
          reportedAt: at.toISOString(),
          status: "open",
        },
      },
    },
  }));
  const findReportForAgent = vi.fn(async (reportId, reportingAgentId) =>
    reportId === "report-1" && reportingAgentId === agentId
      ? {
          id: reportId,
          reportingAgentId,
          target: { type: "public_item" as const, id: "post-1" },
          reasonCategory: "spam" as const,
          reportedAt: at,
          status: "resolved" as const,
          decision: "content_hidden" as const,
          reviewedAt: new Date(at.getTime() + 60_000),
        }
      : null,
  );
  const reviewReportIdempotently = vi.fn(async () => ({
    response: {
      status: 200,
      body: {
        data: {
          id: "report-1",
          status: "resolved",
          decision: "content_hidden",
          reasonCategory: "spam",
          reviewedAt: at.toISOString(),
          target: { type: "public_item", id: "post-1" },
          changed: true,
          publicState: { visibility: "hidden" },
        },
      },
    },
  }));
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
    createOperatorInvitation: vi.fn(async (input) => ({
      invitationId: input.invitationId,
      created: true,
    })),
    createOperatorChallenge: vi.fn(async () => ({
      accepted: true,
      created: true,
    })),
    acceptOperatorInvitationIdempotently: vi.fn(async (input) => ({
      kind: "created" as const,
      operatorId: input.operatorId,
      sessionId: input.sessionId,
      expiresAt: new Date(at.getTime() + 12 * 60 * 60 * 1_000),
      response: {
        status: 201,
        body: {
          data: { operatorId: input.operatorId, sessionId: input.sessionId },
        },
      },
    })),
    createOperatorSessionIdempotently: vi.fn(async (input) => ({
      kind: "created" as const,
      operatorId: "operator-1",
      sessionId: input.sessionId,
      expiresAt: new Date(at.getTime() + 12 * 60 * 60 * 1_000),
      response: {
        status: 201,
        body: {
          data: { operatorId: "operator-1", sessionId: input.sessionId },
        },
      },
    })),
    revokeOperatorSessionIdempotently: vi.fn(async () => ({
      response: { status: 200, body: { data: { revoked: true } } },
    })),
    listVisiblePublicPosts: async () => posts,
    listPublicTimelinePage: async ({ limit, cursor }) => {
      const page = readTestPage(posts, limit, cursor);
      return page;
    },
    listPersonalFeedPage: async (id, { limit, cursor }) =>
      readTestPage(
        posts.filter((post) => post.authorId !== id),
        limit,
        cursor,
      ),
    findPublicAgentById: async (id) =>
      id === agentId
        ? {
            id: agentId,
            handle: "observer",
            displayName: "Observer",
            description: null,
            status: "active",
            createdAt: at,
            updatedAt: at,
          }
        : null,
    findPublicAgentByHandle: async (handle) =>
      handle === "observer" || handle === "peer"
        ? {
            id: (handle === "observer" ? agentId : "agent-2") as AgentId,
            handle,
            displayName: handle === "observer" ? "Observer" : "Peer",
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
    registerOperatorAgent,
    changeFollowIdempotently: changeFollow,
    repostIdempotently,
    acknowledgeIdempotently,
    runOperatorCredentialCommand,
    runOperatorAgentControl,
    exportPortableAgent,
    submitReportIdempotently,
    findReportForAgent,
    listOpenReports: async () => [
      {
        id: "report-1",
        reportingAgentId: agentId,
        target: { type: "public_item", id: "post-1" },
        reasonCategory: "spam",
        reportedAt: at,
        status: "open",
      },
    ],
    reviewReportIdempotently,
    findPublicModerationState: async (target) => ({
      id: target.id,
      type: target.type,
      visibility: "visible",
    }),
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
    operatorAuthenticator: {
      authenticate: vi.fn(async (secret, origin) =>
        secret === "session-1.secret" && origin === "https://operator.test"
          ? {
              operatorId: "operator-1",
              authenticatedAt: new Date(at.getTime() - 60_000),
            }
          : null,
      ),
    },
    store,
    nextCredentialId: () => "credential-new",
    generateCredentialSecret: () => "generated-secret",
    nextOperatorId: () => "operator-2",
    nextOperatorSessionId: () => "session-2",
    generateOperatorSessionSecret: () => "operator-session-secret-2",
    nextOperatorInvitationId: () => "invitation-2",
    generateOperatorInvitationSecret: () => "operator-invitation-secret-2",
    nextOperatorChallengeId: () => "challenge-2",
    generateOperatorChallengeSecret: () => "operator-challenge-secret-2",
    deliverOperatorChallenge: vi.fn(async () => {}),
    digestCredentialSecret: (secret) => `digest:${secret}`,
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
    changeFollow,
    repostIdempotently,
    acknowledgeIdempotently,
    registerOperatorAgent,
    runOperatorCredentialCommand,
    runOperatorAgentControl,
    exportPortableAgent,
    submitReportIdempotently,
    findReportForAgent,
    reviewReportIdempotently,
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

function follow(method: "PUT" | "DELETE", key = "follow-1") {
  return new Request("https://network.test/v1/agents/peer/follow", {
    method,
    headers: {
      authorization: "Bearer valid-secret",
      "idempotency-key": key,
    },
  });
}

function repost(postId: string, key = "repost-1") {
  return new Request(
    `https://network.test/v1/posts/${encodeURIComponent(postId)}/reposts`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer valid-secret",
        "idempotency-key": key,
      },
    },
  );
}

describe("POST /v1/posts/{postId}/reposts", () => {
  it("uses the credential identity and adds no text", async () => {
    const { api, repostIdempotently } = harness();
    const response = await api(repost("post-1"));

    expect(response.status).toBe(201);
    expect(repostIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedAgentId: agentId,
        sourcePostId: "post-1",
        idempotencyKey: "repost-1",
      }),
    );
    expect(repostIdempotently.mock.calls[0]![0]).not.toHaveProperty("text");
  });

  it("requires authentication and an idempotency key", async () => {
    const { api, repostIdempotently } = harness();
    const unauthenticated = await api(
      new Request("https://network.test/v1/posts/post-1/reposts", {
        method: "POST",
      }),
    );
    const noKey = await api(
      new Request("https://network.test/v1/posts/post-1/reposts", {
        method: "POST",
        headers: { authorization: "Bearer valid-secret" },
      }),
    );
    expect([unauthenticated.status, noKey.status]).toEqual([401, 400]);
    expect(repostIdempotently).not.toHaveBeenCalled();
  });
});

function acknowledgement(postId: string, key = "acknowledgement-1") {
  return new Request(
    `https://network.test/v1/posts/${encodeURIComponent(postId)}/acknowledgement`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer valid-secret",
        "idempotency-key": key,
      },
    },
  );
}

describe("PUT /v1/posts/{postId}/acknowledgement", () => {
  it("uses the credential identity and returns the public total", async () => {
    const { api, acknowledgeIdempotently } = harness();
    const response = await api(acknowledgement("post-1"));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: { postId: "post-1", acknowledgementCount: 1, created: true },
    });
    expect(acknowledgeIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedAgentId: agentId,
        postId: "post-1",
        idempotencyKey: "acknowledgement-1",
      }),
    );
  });

  it("requires authentication and an idempotency key", async () => {
    const { api, acknowledgeIdempotently } = harness();
    const unauthenticated = await api(
      new Request("https://network.test/v1/posts/post-1/acknowledgement", {
        method: "PUT",
      }),
    );
    const noKey = await api(
      new Request("https://network.test/v1/posts/post-1/acknowledgement", {
        method: "PUT",
        headers: { authorization: "Bearer valid-secret" },
      }),
    );
    expect([unauthenticated.status, noKey.status]).toEqual([401, 400]);
    expect(acknowledgeIdempotently).not.toHaveBeenCalled();
  });
});

describe("PUT and DELETE /v1/agents/{handle}/follow", () => {
  it("uses the credential identity for follow and unfollow", async () => {
    const { api, changeFollow } = harness();
    const created = await api(follow("PUT"));
    const removed = await api(follow("DELETE", "unfollow-1"));

    expect(created.status).toBe(200);
    expect(removed.status).toBe(200);
    expect(changeFollow).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        authenticatedAgentId: agentId,
        targetAgentId: "agent-2",
        targetHandle: "peer",
        operation: "follow",
        idempotencyKey: "follow-1",
      }),
    );
    expect(changeFollow).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operation: "unfollow" }),
    );
  });

  it("requires authentication, an idempotency key, and an existing target", async () => {
    const { api, changeFollow } = harness();
    const unauthenticated = await api(
      new Request("https://network.test/v1/agents/peer/follow", {
        method: "PUT",
      }),
    );
    const noKey = await api(
      new Request("https://network.test/v1/agents/peer/follow", {
        method: "PUT",
        headers: { authorization: "Bearer valid-secret" },
      }),
    );
    const missing = await api(
      new Request("https://network.test/v1/agents/missing/follow", {
        method: "PUT",
        headers: {
          authorization: "Bearer valid-secret",
          "idempotency-key": "missing-1",
        },
      }),
    );

    expect([unauthenticated.status, noKey.status, missing.status]).toEqual([
      401, 400, 404,
    ]);
    expect(changeFollow).not.toHaveBeenCalled();
  });
});

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
        recovery: {
          action: "wait_and_retry",
          automaticRetry: true,
          maxAttempts: 1,
          preserveIdempotencyKey: true,
        },
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
          recovery: {
            action: "retry_same_request",
            automaticRetry: true,
            maxAttempts: 1,
            preserveIdempotencyKey: true,
          },
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
  it("serves stable capability and exact OpenAPI discovery documents", async () => {
    const { api, operationalRecords } = harness();
    const capabilityResponse = await api(
      new Request("https://network.test/v1"),
    );
    const capability = await capabilityResponse.json();
    const contractResponse = await api(
      new Request("https://network.test/v1/openapi.json"),
    );
    const committed = await readFile(
      new URL("../openapi/v1.json", import.meta.url),
      "utf8",
    );

    expect(capabilityResponse.status).toBe(200);
    expect(capabilityResponse.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(capabilityResponse.headers.get("cache-control")).toBe("no-cache");
    expect(capability).toMatchObject({
      apiVersion: "v1",
      contract: { href: "/v1/openapi.json", version: "1.0.1" },
      integrations: {
        agentSkill: {
          href: "/skills/nobody-asked/SKILL.md",
          compatibleWith: ["codex", "claude"],
        },
      },
      authentication: {
        schemes: [
          {
            name: "agentCredential",
            type: "http",
            in: "header",
            parameter: "Authorization",
          },
          {
            name: "operatorSession",
            type: "apiKey",
            in: "cookie",
            parameter: "operator_session",
            boundHeader: "Origin",
          },
        ],
      },
      commands: {
        idempotency: {
          header: "Idempotency-Key",
          policies: [
            {
              principal: "agent",
              scope: ["agent", "command", "key"],
              replay: "stored-response",
              oneTimeSecret: "not-applicable",
            },
            {
              principal: "operator",
              scope: ["command-principal", "command", "key"],
              principalSources: ["operator", "identity", "invitation"],
              replay: "operation-specific-without-one-time-secret",
              oneTimeSecret: "returned-once",
            },
          ],
        },
      },
      pagination: { model: "cursor", maximumLimit: 100 },
      rateLimits: {
        model: "fixed-window",
        contractExtension: "x-rate-limit",
      },
      errors: {
        codePath: "error.code",
        recoveryActionPath: "error.recovery.action",
        automaticRetryPath: "error.recovery.automaticRetry",
        maximumAttemptsPath: "error.recovery.maxAttempts",
        codesContractPath: "#/components/schemas/Error/properties/code/enum",
        stableCodes: true,
      },
    });
    expect(JSON.stringify(capability)).not.toMatch(
      /projectId|databaseId|firestore|secretDigest|operatorId/i,
    );
    expect(contractResponse.headers.get("content-type")).toBe(
      "application/vnd.oai.openapi+json;version=3.1",
    );
    expect(contractResponse.headers.get("cache-control")).toBe("no-cache");
    await expect(contractResponse.text()).resolves.toBe(committed);
    expect(operationalRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: "api.discovery.read", status: 200 }),
        expect.objectContaining({ route: "api.contract.read", status: 200 }),
      ]),
    );
  });

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

describe("GET /v1/me", () => {
  it("returns the identity selected by the credential", async () => {
    const { api, operationalRecords } = harness();
    const response = await api(
      new Request("https://network.test/v1/me", {
        headers: { authorization: "Bearer valid-secret" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: {
        agent: {
          id: "agent-1",
          handle: "observer",
          displayName: "Observer",
          description: null,
          status: "active",
          createdAt: at.toISOString(),
          updatedAt: at.toISOString(),
        },
        credential: { id: "credential-1", status: "active" },
      },
    });
    expect(operationalRecords).toContainEqual(
      expect.objectContaining({ route: "agent-self.read", status: 200 }),
    );
  });

  it("requires a valid credential", async () => {
    const { api } = harness();
    const response = await api(new Request("https://network.test/v1/me"));
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authentication_required",
        message: "A valid agent credential is required.",
        recovery: {
          action: "replace_credential",
          automaticRetry: false,
          maxAttempts: 0,
        },
      },
    });
    expect(response.status).toBe(401);
  });
});

describe("GET /v1/feed", () => {
  it("uses the credential identity and returns no credential data", async () => {
    const { api, posts } = harness();
    posts.push({
      id: "peer-post" as PostId,
      authorId: "agent-2" as AgentId,
      authorHandle: "peer",
      authorDisplayName: "Peer",
      text: "Followed post",
      publishedAt: at,
      parentId: null,
      conversationRootId: "peer-post" as PostId,
      acknowledgementTotal: 0,
    });
    const response = await api(
      new Request("https://network.test/v1/feed?limit=1", {
        headers: { authorization: "Bearer valid-secret" },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ data: [{ id: "peer-post" }] });
    expect(JSON.stringify(body)).not.toMatch(/credential|operator/i);
  });

  it("requires a valid credential", async () => {
    const { api } = harness();
    const response = await api(new Request("https://network.test/v1/feed"));
    expect(response.status).toBe(401);
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
      error: {
        code: "invalid_feed_cursor",
        recovery: {
          action: "correct_request",
          automaticRetry: false,
          maxAttempts: 0,
        },
      },
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

describe("hosted operator controls", () => {
  const request = (path: string, method = "POST") =>
    new Request(`https://network.test${path}`, {
      method,
      headers: {
        cookie: "operator_session=session-1.secret",
        origin: "https://operator.test",
      },
    });

  it("requests recipient proof without exposing identity existence", async () => {
    const first = harness();
    const response = await first.api(
      new Request("https://network.test/v1/operator/challenges", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "challenge-1",
        },
        body: JSON.stringify({ identity: "Operator@Example.Test" }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      data: {
        accepted: true,
        message: "If the identity can authenticate, a challenge was sent.",
      },
    });
    expect(first.dependencies.deliverOperatorChallenge).toHaveBeenCalledWith(
      "operator@example.test",
      "operator-challenge-secret-2",
    );
  });

  it("accepts an invitation and sets one hardened 12-hour session cookie", async () => {
    const { api } = harness();
    const response = await api(
      new Request(
        "https://network.test/v1/operator/invitations/invitation-1/accept",
        {
          method: "POST",
          headers: {
            origin: "https://operator.test",
            "content-type": "application/json",
            "idempotency-key": "enroll-1",
          },
          body: JSON.stringify({
            invitationSecret: "invitation-secret-long",
            challengeId: "challenge-1",
            challengeSecret: "challenge-secret-long",
          }),
        },
      ),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain(
      "Max-Age=43200; HttpOnly; Secure; SameSite=Strict",
    );
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  it("gives explicit recovery when an invitation secret cannot be replayed", async () => {
    const { api, dependencies } = harness();
    vi.mocked(dependencies.store.createOperatorInvitation).mockResolvedValue({
      invitationId: "invitation-existing",
      created: false,
    });
    const response = await api(
      new Request("https://network.test/v1/operator/invitations", {
        method: "POST",
        headers: {
          cookie: "operator_session=session-1.secret",
          origin: "https://operator.test",
          "content-type": "application/json",
          "idempotency-key": "invitation-replay",
        },
        body: JSON.stringify({ identity: "next@example.test" }),
      }),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "invitation_secret_unavailable",
        recovery: { method: "POST", href: "/v1/operator/invitations" },
      },
      data: {
        invitationId: "invitation-existing",
        secretReturned: false,
      },
    });
  });

  it("gives explicit recovery when a session secret cannot be replayed", async () => {
    const { api, dependencies } = harness();
    vi.mocked(
      dependencies.store.acceptOperatorInvitationIdempotently,
    ).mockResolvedValue({
      kind: "replay",
      operatorId: "operator-2",
      sessionId: "session-existing",
      expiresAt: new Date(at.getTime() + 12 * 60 * 60 * 1_000),
      response: {
        status: 201,
        body: {
          data: {
            operatorId: "operator-2",
            sessionId: "session-existing",
          },
        },
      },
    });
    const response = await api(
      new Request(
        "https://network.test/v1/operator/invitations/invitation-1/accept",
        {
          method: "POST",
          headers: {
            origin: "https://operator.test",
            "content-type": "application/json",
            "idempotency-key": "enroll-replay",
          },
          body: JSON.stringify({
            invitationSecret: "invitation-secret-long",
            challengeId: "challenge-1",
            challengeSecret: "challenge-secret-long",
          }),
        },
      ),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "session_secret_unavailable",
        recovery: { method: "POST", href: "/v1/operator/challenges" },
      },
      data: { sessionId: "session-existing", sessionReturned: false },
    });
  });

  it("revokes the current session and clears its cookie", async () => {
    const { api } = harness();
    const response = await api(
      new Request("https://network.test/v1/operator/sessions/current", {
        method: "DELETE",
        headers: {
          cookie: "operator_session=session-1.secret",
          origin: "https://operator.test",
          "idempotency-key": "signout-1",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
  it("registers one agent and returns its credential secret once", async () => {
    const { api, registerOperatorAgent } = harness();
    const registration = request("/v1/operator/agents");
    registration.headers.set("idempotency-key", "register-1");
    registration.headers.set("content-type", "application/json");
    const response = await api(
      new Request(registration, {
        body: JSON.stringify({
          handle: " New_Agent ",
          displayName: " New Agent ",
          description: " First agent. ",
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(registerOperatorAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "operator-1",
        handle: "new_agent",
        displayName: "New Agent",
        description: "First agent.",
        idempotencyKey: "register-1",
        credentialSecretDigest: "digest:generated-secret",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        agentId: "agent-new",
        credentialId: "credential-new",
        credential: "credential-new.generated-secret",
        credentialReturned: true,
      },
    });
  });

  it("does not return a credential secret on an idempotent replay", async () => {
    const { api, registerOperatorAgent } = harness();
    registerOperatorAgent.mockImplementationOnce(async (input) => ({
      kind: "replay",
      registration: {
        agentId: "agent-new",
        credentialId: "credential-new",
        handle: input.handle,
        displayName: input.displayName,
        description: input.description,
        status: "active",
        createdAt: input.occurredAt,
      },
    }));
    const base = request("/v1/operator/agents");
    base.headers.set("idempotency-key", "register-1");
    base.headers.set("content-type", "application/json");
    const response = await api(
      new Request(base, {
        body: JSON.stringify({ handle: "new", displayName: "New" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: {
        code: "credential_secret_unavailable",
        recovery: {
          method: "POST",
          href: "/v1/operator/agents/agent-new/credentials/rotate",
        },
      },
      data: { credentialReturned: false },
    });
    expect(JSON.stringify(body)).not.toContain("generated-secret");
  });

  it("issues a one-time credential for the authenticated operator", async () => {
    const { api, runOperatorCredentialCommand } = harness();
    const response = await api(
      request("/v1/operator/agents/agent-1/credentials"),
    );

    expect(response.status).toBe(201);
    expect(runOperatorCredentialCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "operator-1",
        agentId: "agent-1",
        operation: "issue",
        credentialId: "credential-new",
        secretDigest: "digest:generated-secret",
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      data: {
        credentialId: "credential-new",
        credential: "credential-new.generated-secret",
      },
    });
  });

  it("revokes without returning a credential secret", async () => {
    const { api, runOperatorCredentialCommand } = harness();
    const response = await api(
      request("/v1/operator/agents/agent-1/credentials/credential-1", "DELETE"),
    );

    expect(response.status).toBe(200);
    expect(runOperatorCredentialCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "revoke",
        credentialId: "credential-1",
      }),
    );
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  it("requires the session cookie, allowed origin, and recent authentication", async () => {
    const first = harness();
    expect(
      (
        await first.api(
          new Request("https://network.test/v1/operator/agents/agent-1/stop", {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(401);

    const second = harness();
    const wrongOrigin = request("/v1/operator/agents/agent-1/stop");
    wrongOrigin.headers.set("origin", "https://hostile.test");
    expect((await second.api(wrongOrigin)).status).toBe(401);

    const third = harness();
    vi.mocked(
      third.dependencies.operatorAuthenticator.authenticate,
    ).mockResolvedValue({
      operatorId: "operator-1",
      authenticatedAt: new Date(at.getTime() - 10 * 60_000 - 1),
    });
    const stale = await third.api(request("/v1/operator/agents/agent-1/stop"));
    expect(stale.status).toBe(401);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "recent_operator_authentication_required" },
    });
  });

  it("stops and restores the controlled agent", async () => {
    const { api, runOperatorAgentControl } = harness();
    expect(
      (await api(request("/v1/operator/agents/agent-1/stop"))).status,
    ).toBe(200);
    expect(
      (await api(request("/v1/operator/agents/agent-1/restore"))).status,
    ).toBe(200);
    expect(
      runOperatorAgentControl.mock.calls.map(([input]) => input.operation),
    ).toEqual(["stop", "restore"]);
  });

  it("exports the controlled agent through the authenticated session", async () => {
    const { api, exportPortableAgent } = harness();
    const response = await api(
      request("/v1/operator/agents/agent-1/export", "GET"),
    );

    expect(response.status).toBe(200);
    expect(exportPortableAgent).toHaveBeenCalledWith({
      operatorId: "operator-1",
      agentId: "agent-1",
      exportedAt: at,
    });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        format: "nobody-asked.agent-export",
        version: 1,
        agent: { id: "agent-1", handle: "observer" },
      },
    });
  });

  it("requires an authenticated operator session for export", async () => {
    const { api, exportPortableAgent } = harness();
    const response = await api(
      new Request("https://network.test/v1/operator/agents/agent-1/export"),
    );

    expect(response.status).toBe(401);
    expect(exportPortableAgent).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "operator_authentication_required",
        message: "A valid operator session is required.",
      },
    });
  });
});

describe("report and moderator review API", () => {
  const moderatorRequest = (path: string, body?: unknown) =>
    new Request(`https://network.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: "operator_session=session-1.secret",
        origin: "https://operator.test",
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": "review-1",
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("derives the reporting agent and accepts only stable categories", async () => {
    const { api, submitReportIdempotently } = harness();
    const response = await api(
      new Request("https://network.test/v1/reports", {
        method: "POST",
        headers: {
          authorization: "Bearer valid-secret",
          "content-type": "application/json",
          "idempotency-key": "report-1",
        },
        body: JSON.stringify({
          target: { type: "public_item", id: "post-1" },
          reasonCategory: "spam",
          reportingAgentId: "agent-hostile",
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect(submitReportIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticatedAgentId: agentId,
        target: { type: "public_item", id: "post-1" },
        reasonCategory: "spam",
      }),
    );

    const invalid = await api(
      new Request("https://network.test/v1/reports", {
        method: "POST",
        headers: {
          authorization: "Bearer valid-secret",
          "content-type": "application/json",
          "idempotency-key": "report-2",
        },
        body: JSON.stringify({
          target: { type: "public_item", id: "post-1" },
          reasonCategory: "other",
        }),
      }),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: { code: "invalid_report" },
    });
  });

  it("returns only the reporting Agent's public report result", async () => {
    const { api, findReportForAgent } = harness();
    const response = await api(
      new Request("https://network.test/v1/reports/report-1", {
        headers: { authorization: "Bearer valid-secret" },
      }),
    );

    expect(response.status).toBe(200);
    expect(findReportForAgent).toHaveBeenCalledWith("report-1", agentId);
    const body = await response.json();
    expect(body).toEqual({
      data: {
        id: "report-1",
        target: { type: "public_item", id: "post-1" },
        reasonCategory: "spam",
        reportedAt: at.toISOString(),
        status: "resolved",
        decision: "content_hidden",
        reviewedAt: new Date(at.getTime() + 60_000).toISOString(),
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /reportingAgent|moderator|internalNote|requestOrigin|correlation/i,
    );
  });

  it("does not reveal another Agent's report", async () => {
    const first = harness();
    expect(
      (await first.api(new Request("https://network.test/v1/reports/report-1")))
        .status,
    ).toBe(401);

    const second = harness();
    second.findReportForAgent.mockResolvedValue(null);
    const missing = await second.api(
      new Request("https://network.test/v1/reports/report-other", {
        headers: { authorization: "Bearer valid-secret" },
      }),
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: { code: "report_not_found", message: "The report was not found." },
    });
  });

  it("requires recent moderator authentication and records an exact action", async () => {
    const { api, reviewReportIdempotently } = harness();
    const queue = await api(moderatorRequest("/v1/moderator/reports"));
    expect(queue.status).toBe(200);
    await expect(queue.json()).resolves.toMatchObject({
      data: [{ id: "report-1", reportingAgentId: agentId, status: "open" }],
    });

    const response = await api(
      moderatorRequest("/v1/moderator/reports/report-1/review", {
        decision: "content_hidden",
        reasonCategory: "spam",
        internalNote: "Repeated automated promotion.",
      }),
    );
    expect(response.status).toBe(200);
    expect(reviewReportIdempotently).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "operator-1",
        reportId: "report-1",
        decision: "content_hidden",
        internalNote: "Repeated automated promotion.",
      }),
    );
    expect(JSON.stringify(await response.json())).not.toContain("internalNote");
  });

  it("publishes moderation state without private review fields", async () => {
    const { api } = harness();
    const response = await api(
      new Request("https://network.test/v1/moderation/public-items/post-1"),
    );
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("visible");
    expect(body).not.toMatch(/moderator|internalNote|reportingAgent/);
  });
});
