import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalFirestoreAdmin,
  resetLocalFirestore,
  type LocalFirestoreAdmin,
} from "@nobody-asked/firestore-support";
import { createFirestoreApiAdapters } from "@nobody-asked/persistence";
import { HttpBrowserApiClient } from "../../browser/src/http-client.js";

import { createFirestoreApi } from "./composition.js";

describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "Firestore API composition",
  () => {
    const at = new Date("2026-11-01T12:00:00.000Z");
    let local: LocalFirestoreAdmin;
    let api: ReturnType<typeof createFirestoreApi>;

    beforeAll(async () => {
      local = createLocalFirestoreAdmin({ appName: "firestore-api-tests" });
      const adapterInput = {
        firestore: local.firestore,
        digestCredentialSecret: (secret: string) => `digest:${secret}`,
        safetyPolicy: {
          async authorizeAgentWrite() {},
        },
      };
      api = createFirestoreApi({
        ...adapterInput,
        nextCorrelationId: () => "correlation-1",
        now: () => new Date(at),
        operationalLogger: { write() {} },
        monotonicNow: () => 0,
      });
      await resetLocalFirestore();
    });

    beforeEach(async () => {
      await resetLocalFirestore();
      const adapters = createFirestoreApiAdapters({
        firestore: local.firestore,
        digestCredentialSecret: (secret) => `digest:${secret}`,
        safetyPolicy: { async authorizeAgentWrite() {} },
      });
      await adapters.identity.createAgentProfile({
        id: "agent-1",
        handle: "observer",
        displayName: "Observer",
        description: null,
        status: "active",
        createdAt: at,
        updatedAt: at,
      });
      await adapters.identity.createAgentProfile({
        id: "agent-2",
        handle: "peer",
        displayName: "Peer",
        description: "Personal feed fixture.",
        status: "active",
        createdAt: at,
        updatedAt: at,
      });
      await adapters.access.issueCredential({
        id: "credential-1",
        agentId: "agent-1",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
    });

    afterAll(async () => deleteApp(local.app));

    it("publishes once and serves every browser read contract", async () => {
      const created = await api(publishRequest());
      const replay = await api(publishRequest());
      const createdBody = (await created.json()) as { data: { id: string } };
      const id = createdBody.data.id;

      expect(created.status).toBe(201);
      expect(await replay.json()).toEqual(createdBody);

      const followed = await api(followRequest("PUT", "follow-1"));
      const followReplay = await api(followRequest("PUT", "follow-1"));
      expect(followed.status).toBe(200);
      expect(await followReplay.json()).toEqual(await followed.clone().json());

      const reposted = await api(repostRequest(id, "repost-1"));
      const repostReplay = await api(repostRequest(id, "repost-1"));
      const duplicateRepost = await api(repostRequest(id, "repost-2"));
      expect(reposted.status).toBe(201);
      expect(await repostReplay.json()).toEqual(await reposted.clone().json());
      expect(duplicateRepost.status).toBe(200);
      const repostBody = (await reposted.json()) as { data: { id: string } };
      await expect(duplicateRepost.json()).resolves.toMatchObject({
        data: { id: repostBody.data.id, created: false },
      });

      const acknowledged = await api(acknowledgementRequest(id, "ack-1"));
      const acknowledgementReplay = await api(
        acknowledgementRequest(id, "ack-1"),
      );
      const duplicateAcknowledgement = await api(
        acknowledgementRequest(id, "ack-2"),
      );
      expect(acknowledged.status).toBe(201);
      expect(await acknowledgementReplay.json()).toEqual(
        await acknowledged.clone().json(),
      );
      expect(duplicateAcknowledgement.status).toBe(200);
      await expect(duplicateAcknowledgement.json()).resolves.toMatchObject({
        data: { acknowledgementCount: 1, created: false },
      });

      const routes = [
        "/health/ready",
        "/v1/timeline",
        "/v1/agents/observer",
        "/v1/agents/observer/posts",
        `/v1/posts/${id}`,
        `/v1/conversations/${id}`,
        "/v1/agents/observer/following",
        "/v1/agents/observer/followers",
      ];
      const responses = await Promise.all(
        routes.map((route) => api(new Request(`https://network.test${route}`))),
      );
      expect(responses.map((response) => response.status)).toEqual(
        routes.map(() => 200),
      );
      await expect(responses[0]!.json()).resolves.toEqual({ status: "ready" });
      const timelineBody = (await responses[1]!.json()) as {
        data: Array<Record<string, unknown>>;
        page: { nextCursor: string | null };
      };
      expect(timelineBody.page.nextCursor).toBeNull();
      expect(timelineBody.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: repostBody.data.id,
            type: "repost",
            repostingAgent: expect.objectContaining({ id: "agent-1" }),
            source: expect.objectContaining({
              id,
              author: expect.objectContaining({ id: "agent-1" }),
            }),
          }),
          expect.objectContaining({
            id,
            author: expect.objectContaining({ handle: "observer" }),
            acknowledgementCount: 1,
            state: { visibility: "visible" },
          }),
        ]),
      );
      await expect(responses[5]!.json()).resolves.toMatchObject({
        data: { root: { post: { id }, replies: [] }, missingBranchCount: 0 },
      });

      const browser = new HttpBrowserApiClient({
        baseUrl: "https://network.test",
        fetch: async (input, init) => api(new Request(input, init)),
      });
      const browserTimeline = await browser.getPublicTimeline();
      expect(browserTimeline.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "repost",
            repost: expect.objectContaining({
              id: repostBody.data.id,
              repostingAgent: expect.objectContaining({ id: "agent-1" }),
              source: expect.objectContaining({ id }),
            }),
          }),
          expect.objectContaining({
            kind: "post",
            post: expect.objectContaining({ id }),
          }),
        ]),
      );
      await expect(browser.getAgent("observer")).resolves.toMatchObject({
        id: "agent-1",
      });
      await expect(browser.getPost(id)).resolves.toMatchObject({ id });
      await expect(browser.getConversation(id)).resolves.toMatchObject({
        root: { post: { id } },
      });
      const agentPosts = await browser.getAgentPosts("observer");
      expect(agentPosts.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "post",
            post: expect.objectContaining({ id }),
          }),
          expect.objectContaining({
            kind: "repost",
            repost: expect.objectContaining({ id: repostBody.data.id }),
          }),
        ]),
      );
      await expect(
        browser.getRelationships("observer", "following"),
      ).resolves.toMatchObject({ items: [{ id: "agent-2" }] });

      const unfollowed = await api(followRequest("DELETE", "unfollow-1"));
      expect(unfollowed.status).toBe(200);
      await expect(
        browser.getRelationships("observer", "following"),
      ).resolves.toEqual({ items: [], nextCursor: null });
    }, 30_000);

    it("pages more than 50 records and rejects a hostile cursor", async () => {
      const batch = local.firestore.batch();
      for (let index = 0; index < 55; index += 1) {
        const id = `post-${String(index).padStart(2, "0")}`;
        batch.create(local.firestore.collection("publicItems").doc(id), {
          id,
          type: "post",
          authorId: "agent-1",
          authorHandle: "observer",
          authorDisplayName: "Observer",
          text: `Observation ${index}.`,
          publishedAt: Timestamp.fromMillis(at.getTime() + index),
          parentId: null,
          conversationRootId: id,
          visibility: "visible",
          acknowledgementTotal: 0,
        });
      }
      await batch.commit();

      const first = await api(
        new Request("https://network.test/v1/timeline?limit=51"),
      );
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as {
        data: unknown[];
        page: { nextCursor: string };
      };
      expect(firstBody.data).toHaveLength(51);
      const second = await api(
        new Request(
          `https://network.test/v1/timeline?limit=51&cursor=${encodeURIComponent(firstBody.page.nextCursor)}`,
        ),
      );
      const secondBody = (await second.json()) as {
        data: { id: string }[];
        page: { nextCursor: string | null };
      };
      expect(secondBody.data.map((post) => post.id)).toEqual([
        "post-03",
        "post-02",
        "post-01",
        "post-00",
      ]);
      expect(secondBody.page.nextCursor).toBeNull();

      const hostile = await api(
        new Request(
          "https://network.test/v1/timeline?cursor=%7B%22__proto__%22%3A%7B%22polluted%22%3Atrue%7D%7D",
        ),
      );
      expect(hostile.status).toBe(400);
      await expect(hostile.json()).resolves.toEqual({
        error: {
          code: "invalid_feed_cursor",
          message: "The feed cursor is invalid.",
        },
      });
    }, 30_000);
  },
);

function publishRequest() {
  return new Request("https://network.test/v1/posts", {
    method: "POST",
    headers: {
      authorization: "Bearer credential-1.secret",
      "idempotency-key": "request-1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: "A stored observation." }),
  });
}

function followRequest(method: "PUT" | "DELETE", key: string) {
  return new Request("https://network.test/v1/agents/peer/follow", {
    method,
    headers: {
      authorization: "Bearer credential-1.secret",
      "idempotency-key": key,
    },
  });
}

function repostRequest(postId: string, key: string) {
  return new Request(
    `https://network.test/v1/posts/${encodeURIComponent(postId)}/reposts`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer credential-1.secret",
        "idempotency-key": key,
      },
    },
  );
}

function acknowledgementRequest(postId: string, key: string) {
  return new Request(
    `https://network.test/v1/posts/${encodeURIComponent(postId)}/acknowledgement`,
    {
      method: "PUT",
      headers: {
        authorization: "Bearer credential-1.secret",
        "idempotency-key": key,
      },
    },
  );
}
