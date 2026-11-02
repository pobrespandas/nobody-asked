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
    let credentialSequence = 0;

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
        nextCredentialId: () => `credential-new-${++credentialSequence}`,
        generateCredentialSecret: () =>
          `generated-secret-${credentialSequence}`,
        now: () => new Date(at),
        operationalLogger: { write() {} },
        monotonicNow: () => 0,
      });
      await resetLocalFirestore();
    });

    beforeEach(async () => {
      await resetLocalFirestore();
      credentialSequence = 0;
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
        controllingOperatorId: "operator-1",
      });
      await adapters.identity.createAgentProfile({
        id: "agent-2",
        handle: "peer",
        displayName: "Peer",
        description: "Personal feed fixture.",
        status: "active",
        createdAt: at,
        updatedAt: at,
        controllingOperatorId: "operator-1",
      });
      await adapters.access.issueCredential({
        id: "credential-1",
        agentId: "agent-1",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      await local.firestore
        .collection("operators")
        .doc("operator-1")
        .set({
          normalizedIdentity: "operator@example.test",
          createdAt: Timestamp.fromDate(at),
        });
      await local.firestore
        .collection("operatorSessions")
        .doc("session-1")
        .set({
          operatorId: "operator-1",
          secretDigest: "digest:session-secret",
          origin: "https://operator.test",
          authenticatedAt: Timestamp.fromDate(at),
          expiresAt: Timestamp.fromDate(new Date(at.getTime() + 60 * 60_000)),
          revokedAt: null,
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

    it("issues, rotates, revokes, stops, and restores through operator controls", async () => {
      expect(
        (
          await api(
            operatorRequest(
              "/v1/operator/agents/agent-2/credentials",
              "POST",
              "https://hostile.test",
            ),
          )
        ).status,
      ).toBe(401);
      const issue = await api(
        operatorRequest("/v1/operator/agents/agent-2/credentials"),
      );
      expect(issue.status).toBe(201);
      const issued = (await issue.json()) as {
        data: { credentialId: string; credential: string };
      };
      expect(issued.data.credential).toBe(
        "credential-new-1.generated-secret-1",
      );
      const storedIssue = await local.firestore
        .collection("credentials")
        .doc(issued.data.credentialId)
        .get();
      expect(storedIssue.data()?.secretDigest).toBe(
        "digest:generated-secret-1",
      );
      expect(storedIssue.data()?.secret).toBeUndefined();

      const rotate = await api(
        operatorRequest("/v1/operator/agents/agent-2/credentials/rotate"),
      );
      expect(rotate.status).toBe(200);
      const rotated = (await rotate.json()) as {
        data: { credentialId: string; credential: string };
      };
      expect(rotated.data.credentialId).toBe("credential-new-2");
      expect(
        (
          await local.firestore
            .collection("credentials")
            .doc("credential-new-1")
            .get()
        ).data()?.revokedAt,
      ).toBeInstanceOf(Timestamp);

      const stop = await api(
        operatorRequest("/v1/operator/agents/agent-2/stop"),
      );
      expect(stop.status).toBe(200);
      expect(
        (
          await local.firestore
            .collection("credentials")
            .doc("credential-new-2")
            .get()
        ).data()?.revokedAt,
      ).toBeInstanceOf(Timestamp);
      expect(
        await api(
          new Request("https://network.test/v1/feed", {
            headers: { authorization: `Bearer ${rotated.data.credential}` },
          }),
        ),
      ).toMatchObject({ status: 401 });
      expect(
        (await api(operatorRequest("/v1/operator/agents/agent-2/credentials")))
          .status,
      ).toBe(403);

      const restore = await api(
        operatorRequest("/v1/operator/agents/agent-2/restore"),
      );
      expect(restore.status).toBe(200);
      const reissue = await api(
        operatorRequest("/v1/operator/agents/agent-2/credentials"),
      );
      expect(reissue.status).toBe(201);
      const reissued = (await reissue.json()) as {
        data: { credentialId: string };
      };
      const revoke = await api(
        operatorRequest(
          `/v1/operator/agents/agent-2/credentials/${reissued.data.credentialId}`,
          "DELETE",
        ),
      );
      expect(revoke.status).toBe(200);
      expect(JSON.stringify(await revoke.json())).not.toContain("secret");

      const audits = await local.firestore.collection("auditRecords").get();
      expect(audits.docs.map((entry) => entry.data().action)).toEqual(
        expect.arrayContaining([
          "credential.issued",
          "credential.rotated",
          "agent.stopped",
          "agent.restored",
          "credential.revoked",
        ]),
      );

      await local.firestore.collection("agentProfiles").doc("agent-2").update({
        controllingOperatorId: "operator-other",
      });
      expect(
        (await api(operatorRequest("/v1/operator/agents/agent-2/stop"))).status,
      ).toBe(403);
      await local.firestore
        .collection("operatorSessions")
        .doc("session-1")
        .update({ revokedAt: Timestamp.fromDate(at) });
      expect(
        (await api(operatorRequest("/v1/operator/agents/agent-1/stop"))).status,
      ).toBe(401);
    }, 30_000);

    it("exports one controlled agent without private records", async () => {
      const published = await api(publishRequest());
      expect(published.status).toBe(201);
      await local.firestore
        .collection("moderationActions")
        .doc("private-1")
        .set({
          subjectType: "agent",
          subjectId: "agent-1",
          state: "suspended",
          reasonCategory: "abuse",
          actionAt: Timestamp.fromDate(at),
          internalNote: "Private investigation detail.",
          moderatorId: "moderator-1",
        });

      const response = await api(
        operatorRequest("/v1/operator/agents/agent-1/export", "GET"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          format: string;
          agent: { id: string };
          publicActivity: unknown[];
        };
      };
      expect(body.data).toMatchObject({
        format: "nobody-asked.agent-export",
        agent: { id: "agent-1" },
      });
      expect(body.data.publicActivity).toHaveLength(1);
      expect(JSON.stringify(body)).not.toMatch(
        /credential|operator@example|internalNote|moderatorId|requestOrigin/i,
      );

      const unauthenticated = await api(
        new Request("https://network.test/v1/operator/agents/agent-1/export"),
      );
      expect(unauthenticated.status).toBe(401);

      await local.firestore.collection("agentProfiles").doc("agent-1").update({
        controllingOperatorId: "operator-other",
      });
      const denied = await api(
        operatorRequest("/v1/operator/agents/agent-1/export", "GET"),
      );
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toEqual({
        error: {
          code: "operator_control_denied",
          message: "The operator cannot control this agent.",
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

function operatorRequest(
  path: string,
  method = "POST",
  origin = "https://operator.test",
) {
  return new Request(`https://network.test${path}`, {
    method,
    headers: {
      cookie: "operator_session=session-1.session-secret",
      origin,
    },
  });
}
