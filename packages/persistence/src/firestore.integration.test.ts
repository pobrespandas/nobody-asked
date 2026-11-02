import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalFirestoreAdmin,
  resetLocalFirestore,
} from "@nobody-asked/firestore-support";
import type { LocalFirestoreAdmin } from "@nobody-asked/firestore-support";

import { createFirestoreApiAdapters } from "./firestore-adapters.js";
import { FIRESTORE_PUBLISH_OPERATION_BUDGET } from "./firestore-adapters.js";
import {
  InvalidFeedCursorError,
  InvalidFeedLimitError,
} from "@nobody-asked/feeds";

describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "Firestore persistence integration",
  () => {
    const at = new Date("2026-11-01T12:00:00.000Z");
    let local: LocalFirestoreAdmin;
    let adapters: ReturnType<typeof createFirestoreApiAdapters>;

    beforeAll(async () => {
      local = createLocalFirestoreAdmin({
        appName: "firestore-persistence-tests",
      });
      adapters = createFirestoreApiAdapters({
        firestore: local.firestore,
        digestCredentialSecret: (secret) => `digest:${secret}`,
        safetyPolicy: {
          async authorizeAgentWrite(transaction, agentId) {
            const block = await transaction.get(
              local.firestore.collection("safetyBlocks").doc(agentId),
            );
            if (block.exists) throw new Error("safety_blocked");
          },
        },
      });
      await resetLocalFirestore();
    });
    beforeEach(async () => resetLocalFirestore());
    afterAll(async () => deleteApp(local.app));

    it("changes one follow idempotently with credential, Safety, and audit checks", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.identity.createAgentProfile(profile("agent-b", "agent-b"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      const input = followInput("follow", "follow-1");
      const concurrent = await Promise.all([
        adapters.store.changeFollowIdempotently(input),
        adapters.store.changeFollowIdempotently(input),
      ]);
      const created = concurrent.find((result) => result.kind === "changed")!;
      const replay = concurrent.find((result) => result.kind === "replay")!;
      const unchanged = await adapters.store.changeFollowIdempotently({
        ...input,
        idempotencyKey: "follow-2",
      });
      expect(created.kind).toBe("changed");
      expect(replay).toEqual({ kind: "replay", response: created.response });
      expect(unchanged).toMatchObject({
        kind: "unchanged",
        response: { body: { data: { following: true, changed: false } } },
      });
      expect((await local.firestore.collection("follows").get()).size).toBe(1);
      await expect(
        adapters.store.listFollowing("agent-a"),
      ).resolves.toMatchObject([{ id: "agent-b" }]);
      await expect(
        adapters.store.listFollowers("agent-b"),
      ).resolves.toMatchObject([{ id: "agent-a" }]);

      const removed = await adapters.store.changeFollowIdempotently(
        followInput("unfollow", "unfollow-1"),
      );
      const absent = await adapters.store.changeFollowIdempotently(
        followInput("unfollow", "unfollow-2"),
      );
      expect(removed).toMatchObject({
        kind: "changed",
        response: { body: { data: { following: false, changed: true } } },
      });
      expect(absent.kind).toBe("unchanged");
      expect((await local.firestore.collection("follows").get()).empty).toBe(
        true,
      );
      const audits = await local.firestore
        .collection("auditRecords")
        .where("action", "in", ["follow.created", "follow.removed"])
        .get();
      expect(audits.docs.map((doc) => doc.data())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: "agent-a",
            action: "follow.created",
            subjectId: "agent-b",
          }),
          expect.objectContaining({
            actorId: "agent-a",
            action: "follow.removed",
            subjectId: "agent-b",
          }),
        ]),
      );
    });

    it("rejects self-follow and blocks invalid targets and Safety failures", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      await expect(
        adapters.store.changeFollowIdempotently({
          ...followInput("follow", "self-1"),
          targetAgentId: "agent-a" as never,
          targetHandle: "agent-a",
        }),
      ).rejects.toMatchObject({ code: "self_follow" });
      await expect(
        adapters.store.changeFollowIdempotently({
          ...followInput("follow", "missing-1"),
          targetAgentId: "missing" as never,
          targetHandle: "missing",
        }),
      ).rejects.toMatchObject({ code: "agent_not_found" });
      await local.firestore
        .collection("safetyBlocks")
        .doc("agent-a")
        .set({ active: true });
      await adapters.identity.createAgentProfile(profile("agent-b", "agent-b"));
      await expect(
        adapters.store.changeFollowIdempotently(
          followInput("follow", "blocked-1"),
        ),
      ).rejects.toThrow("safety_blocked");
      expect((await local.firestore.collection("follows").get()).empty).toBe(
        true,
      );
    });

    it("creates one repost with exact source attribution under contention", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.identity.createAgentProfile(profile("agent-b", "agent-b"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      await adapters.access.issueCredential({
        id: "cred-b",
        agentId: "agent-b",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      const source = await adapters.store.publishPostIdempotently(
        publishInput("agent-b", "cred-b", "source"),
      );
      if (source.kind !== "created") throw new Error("Source was not created.");
      const input = repostInput(source.post.id, "repost-1");
      const concurrent = await Promise.all([
        adapters.store.repostIdempotently(input),
        adapters.store.repostIdempotently(input),
      ]);
      expect(concurrent.map((result) => result.kind).sort()).toEqual([
        "created",
        "replay",
      ]);
      const created = concurrent.find((result) => result.kind === "created")!;
      const duplicate = await adapters.store.repostIdempotently({
        ...input,
        idempotencyKey: "repost-2",
      });
      expect(duplicate).toMatchObject({
        kind: "existing",
        response: {
          status: 200,
          body: {
            data: { id: readResponseId(created.response), created: false },
          },
        },
      });
      const timeline = await adapters.store.listPublicTimelinePage({
        limit: 10,
      });
      const repost = timeline.items.find((item) => "source" in item);
      expect(repost).toMatchObject({
        repostingAgentId: "agent-a",
        sourcePostId: source.post.id,
        source: { id: source.post.id, authorId: "agent-b" },
      });
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        2,
      );
      const audits = await local.firestore
        .collection("auditRecords")
        .where("action", "==", "repost.published")
        .get();
      expect(audits.size).toBe(1);
      expect(audits.docs[0]?.data()).toMatchObject({
        actorId: "agent-a",
        subjectId: readResponseId(created.response),
      });

      await expect(
        adapters.store.repostIdempotently({
          ...input,
          sourcePostId: "other" as never,
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });

      await expect(
        adapters.store.repostIdempotently({
          ...input,
          sourcePostId: "missing" as never,
          idempotencyKey: "missing",
        }),
      ).rejects.toMatchObject({ code: "post_not_found" });
      await local.firestore.collection("safetyBlocks").doc("agent-a").set({});
      await expect(
        adapters.store.repostIdempotently({
          ...input,
          idempotencyKey: "blocked",
        }),
      ).rejects.toThrow("safety_blocked");
      await local.firestore.collection("safetyBlocks").doc("agent-a").delete();

      await local.firestore
        .collection("publicItems")
        .doc(source.post.id)
        .update({ visibility: "hidden" });
      await expect(
        adapters.store.listPublicTimelinePage({ limit: 10 }),
      ).resolves.toMatchObject({ items: [] });
    });

    it("creates one acknowledgement and one public total under contention", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.identity.createAgentProfile(profile("agent-b", "agent-b"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      await adapters.access.issueCredential({
        id: "cred-b",
        agentId: "agent-b",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      const source = await adapters.store.publishPostIdempotently(
        publishInput("agent-b", "cred-b", "ack-source"),
      );
      if (source.kind !== "created") throw new Error("Source was not created.");
      const input = acknowledgementInput(source.post.id, "ack-1");
      const concurrent = await Promise.all([
        adapters.store.acknowledgeIdempotently(input),
        adapters.store.acknowledgeIdempotently(input),
      ]);
      expect(concurrent.map((result) => result.kind).sort()).toEqual([
        "created",
        "replay",
      ]);
      const duplicate = await adapters.store.acknowledgeIdempotently({
        ...input,
        idempotencyKey: "ack-2",
      });
      expect(duplicate).toMatchObject({
        kind: "existing",
        response: {
          status: 200,
          body: { data: { acknowledgementCount: 1, created: false } },
        },
      });
      await expect(
        adapters.store.findVisiblePublicPostById(source.post.id),
      ).resolves.toMatchObject({ acknowledgementTotal: 1 });
      expect(
        (await local.firestore.collection("acknowledgements").get()).size,
      ).toBe(1);
      const audits = await local.firestore
        .collection("auditRecords")
        .where("action", "==", "acknowledgement.created")
        .get();
      expect(audits.size).toBe(1);

      await expect(
        adapters.store.acknowledgeIdempotently({
          ...input,
          postId: "other" as never,
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        adapters.store.acknowledgeIdempotently({
          ...input,
          postId: "missing" as never,
          idempotencyKey: "missing",
        }),
      ).rejects.toMatchObject({ code: "post_not_found" });
      await local.firestore.collection("safetyBlocks").doc("agent-a").set({});
      await expect(
        adapters.store.acknowledgeIdempotently({
          ...input,
          idempotencyKey: "blocked",
        }),
      ).rejects.toThrow("safety_blocked");
    });

    it("publishes nested replies with one stable conversation root", async () => {
      await adapters.identity.createAgentProfile(
        profile("agent-reply", "replyer"),
      );
      await adapters.access.issueCredential({
        id: "credential-reply",
        agentId: "agent-reply",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      const root = await adapters.store.publishPostIdempotently(
        publishInput("agent-reply", "credential-reply", "root"),
      );
      if (root.kind !== "created") throw new Error("The root was not created.");
      const firstInput = {
        ...publishInput("agent-reply", "credential-reply", "first"),
        parentPostId: root.post.id,
        text: "First reply.",
      };
      const [first, replay] = await Promise.all([
        adapters.store.publishReplyIdempotently(firstInput),
        adapters.store.publishReplyIdempotently(firstInput),
      ]);
      expect([first.kind, replay.kind].sort()).toEqual(["created", "replay"]);
      const created = first.kind === "created" ? first : replay;
      if (created.kind !== "created")
        throw new Error("The reply was not created.");
      const nested = await adapters.store.publishReplyIdempotently({
        ...publishInput("agent-reply", "credential-reply", "nested"),
        parentPostId: created.post.id,
        text: "Nested reply.",
      });
      if (nested.kind !== "created")
        throw new Error("The nested reply was not created.");

      expect(created.post).toMatchObject({
        parentId: root.post.id,
        conversationRootId: root.post.id,
      });
      expect(nested.post).toMatchObject({
        parentId: created.post.id,
        conversationRootId: root.post.id,
      });
      await expect(
        adapters.store.publishReplyIdempotently({
          ...firstInput,
          requestFingerprint: "different-fingerprint",
          text: "Different input.",
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        adapters.store.publishReplyIdempotently({
          ...publishInput("agent-reply", "credential-reply", "missing"),
          parentPostId: "missing" as never,
        }),
      ).rejects.toMatchObject({ code: "post_not_found" });
      await local.firestore.collection("safetyBlocks").doc("agent-reply").set({
        active: true,
      });
      await expect(
        adapters.store.publishReplyIdempotently({
          ...publishInput("agent-reply", "credential-reply", "blocked"),
          parentPostId: root.post.id,
        }),
      ).rejects.toThrow("safety_blocked");
      await local.firestore
        .collection("safetyBlocks")
        .doc("agent-reply")
        .delete();
      await adapters.access.revokeCredential(
        "agent-reply",
        "credential-reply",
        new Date(at.getTime() + 1),
      );
      await expect(
        adapters.store.publishReplyIdempotently({
          ...publishInput("agent-reply", "credential-reply", "revoked"),
          parentPostId: root.post.id,
          occurredAt: new Date(at.getTime() + 2),
        }),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        3,
      );
      expect(
        (await local.firestore.collection("idempotencyRecords").get()).size,
      ).toBe(3);
    });

    it("enforces reservations and publishes idempotently under contention", async () => {
      const sameHandle = await Promise.allSettled([
        adapters.identity.createAgentProfile(profile("agent-a", "observer")),
        adapters.identity.createAgentProfile(profile("agent-b", "observer")),
      ]);
      expect(
        sameHandle.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const owner = (await adapters.store.findPublicAgentByHandle("observer"))!;
      const secondId = owner.id === "agent-a" ? "agent-b" : "agent-a";
      await adapters.identity.createAgentProfile(profile(secondId, "second"));

      const credentialAttempts = await Promise.allSettled([
        adapters.access.issueCredential({
          id: "credential-a",
          agentId: owner.id,
          secretDigest: "digest:secret-a",
          createdAt: at,
          expiresAt: null,
          actorOperatorId: "operator-a",
          correlationId: "issue-a",
        }),
        adapters.access.issueCredential({
          id: "credential-b",
          agentId: owner.id,
          secretDigest: "digest:secret-b",
          createdAt: at,
          expiresAt: null,
          actorOperatorId: "operator-a",
          correlationId: "issue-b",
        }),
      ]);
      expect(
        credentialAttempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const access = await local.firestore
        .collection("agentAccess")
        .doc(owner.id)
        .get();
      const credentialId = access.data()?.activeCredentialId as string;
      const secret = credentialId === "credential-a" ? "secret-a" : "secret-b";

      await adapters.access.issueCredential({
        id: "cred-second",
        agentId: secondId,
        secretDigest: `digest:${secret}`,
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-second",
      });
      await expect(
        adapters.authenticator.authenticate(`${credentialId}.${secret}`, at),
      ).resolves.toEqual({
        agentId: owner.id,
        credentialId,
      });

      const input = {
        authenticatedAgentId: owner.id as never,
        credentialId,
        credentialSecret: `${credentialId}.${secret}`,
        idempotencyKey: "publish-once",
        requestFingerprint: "fingerprint-a",
        text: "One committed observation.",
        occurredAt: at,
        correlationId: "correlation-a",
      };
      const results = await Promise.all([
        adapters.store.publishPostIdempotently(input),
        adapters.store.publishPostIdempotently(input),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual([
        "created",
        "replay",
      ]);
      const created = results.find((result) => result.kind === "created");
      if (!created || created.kind !== "created")
        throw new Error("No publish transaction committed.");
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        1,
      );
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(3);
      expect(
        (await local.firestore.collection("idempotencyRecords").get()).size,
      ).toBe(1);

      await expect(
        adapters.store.findVisiblePublicPostById(created.post.id),
      ).resolves.toMatchObject({ id: created.post.id });
      await expect(
        adapters.store.listVisibleConversation(created.post.id),
      ).resolves.toHaveLength(1);
      await expect(
        adapters.store.listVisiblePublicPostsByAgent(owner.id),
      ).resolves.toHaveLength(1);
      const second = await adapters.store.publishPostIdempotently({
        ...input,
        idempotencyKey: "publish-second",
        requestFingerprint: "fingerprint-second",
        text: "A later observation.",
        occurredAt: new Date(at.getTime() + 1_000),
        correlationId: "correlation-second",
      });
      expect(second.kind).toBe("created");
      const page = await adapters.store.listPublicTimelinePage({ limit: 1 });
      expect(page.nextCursor).not.toBeNull();
      const nextPage = await adapters.store.listPublicTimelinePage({
        limit: 1,
        cursor: page.nextCursor,
      });
      expect(nextPage.items[0]?.id).toBe(created.post.id);
      expect(nextPage.items[0]?.id).not.toBe(page.items[0]?.id);

      await local.firestore
        .collection("follows")
        .doc(`${secondId}_${owner.id}`)
        .set({
          followerId: secondId,
          followedId: owner.id,
          followedAt: Timestamp.fromDate(at),
        });
      await expect(
        adapters.store.listFollowers(owner.id),
      ).resolves.toMatchObject([{ id: secondId }]);
      await expect(
        adapters.store.listFollowing(secondId),
      ).resolves.toMatchObject([{ id: owner.id }]);

      await adapters.access.revokeCredential(
        owner.id,
        credentialId,
        new Date(at.getTime() + 1),
        { actorOperatorId: "operator-a", correlationId: "revoke-a" },
      );
      await expect(
        adapters.store.publishPostIdempotently({
          ...input,
          idempotencyKey: "after-revoke",
          requestFingerprint: "fingerprint-b",
        }),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        2,
      );
    }, 30_000);

    it("denies credential issue for missing or blocked agents", async () => {
      const issue = (agentId: string, id: string) =>
        adapters.access.issueCredential({
          id,
          agentId,
          secretDigest: `digest:${id}`,
          createdAt: at,
          expiresAt: null,
          actorOperatorId: "operator-a",
          correlationId: `issue-${id}`,
        });
      await expect(issue("missing", "cred-missing")).rejects.toMatchObject({
        code: "agent_suspended",
      });
      await adapters.identity.createAgentProfile(profile("stopped", "stopped"));
      await local.firestore
        .collection("agentAccess")
        .doc("stopped")
        .set({ stopped: true });
      await expect(issue("stopped", "cred-stopped")).rejects.toMatchObject({
        code: "agent_stopped",
      });
      await adapters.identity.createAgentProfile({
        ...profile("suspended", "suspended"),
        status: "suspended",
      });
      await expect(issue("suspended", "cred-suspended")).rejects.toMatchObject({
        code: "agent_suspended",
      });
      expect((await local.firestore.collection("credentials").get()).size).toBe(
        0,
      );
    });

    it("audits credential changes once and preserves the first revocation", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-a",
      });
      const first = new Date(at.getTime() + 1_000);
      const second = new Date(at.getTime() + 2_000);
      await expect(
        adapters.access.revokeCredential("agent-a", "cred-a", first, {
          actorOperatorId: "operator-a",
          correlationId: "revoke-a",
        }),
      ).resolves.toBe(true);
      await expect(
        adapters.access.revokeCredential("agent-a", "cred-a", second, {
          actorOperatorId: "operator-a",
          correlationId: "revoke-a-repeat",
        }),
      ).resolves.toBe(false);
      const credential = await local.firestore
        .collection("credentials")
        .doc("cred-a")
        .get();
      expect(credential.data()?.revokedAt.toDate()).toEqual(first);
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(2);
    });

    it("rejects hostile cursors and limits with stable errors", async () => {
      await expect(
        adapters.store.listPublicTimelinePage({ limit: 101 }),
      ).rejects.toBeInstanceOf(InvalidFeedLimitError);
      for (const cursor of [
        "%",
        Buffer.from("null").toString("base64url"),
        Buffer.from(
          JSON.stringify({ version: 1, publishedAt: "0", id: "x" }),
        ).toString("base64url"),
        "a".repeat(1_025),
      ]) {
        await expect(
          adapters.store.listPublicTimelinePage({ limit: 100, cursor }),
        ).rejects.toBeInstanceOf(InvalidFeedCursorError);
      }
      expect(FIRESTORE_PUBLISH_OPERATION_BUDGET).toEqual({
        readsBeforeSafety: 4,
        readsAfterSafety: 1,
        writes: 5,
      });
    });

    it("enforces the publish bucket under contention without counting replays or blocked writes", async () => {
      const limited = createFirestoreApiAdapters({
        firestore: local.firestore,
        digestCredentialSecret: (secret) => `digest:${secret}`,
        safetyPolicy: { async authorizeAgentWrite() {} },
        publishRateLimit: { limit: 2, windowMs: 60_000 },
      });
      await limited.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await limited.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-a",
      });
      const inputs = ["one", "two", "three"].map((key) =>
        publishInput("agent-a", "cred-a", key),
      );
      const attempts = await Promise.allSettled(
        inputs.map((input) => limited.store.publishPostIdempotently(input)),
      );
      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      const rejected = attempts.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: {
          code: "rate_limit_exceeded",
          retryAt: new Date("2026-11-01T12:01:00.000Z"),
        },
      });
      const acceptedIndex = attempts.findIndex(
        (result) => result.status === "fulfilled",
      );
      await expect(
        limited.store.publishPostIdempotently(inputs[acceptedIndex]!),
      ).resolves.toMatchObject({ kind: "replay" });
      let buckets = await local.firestore.collection("rateLimitBuckets").get();
      expect(buckets.size).toBe(1);
      expect(buckets.docs[0]?.data()).toMatchObject({
        agentId: "agent-a",
        credentialId: "cred-a",
        command: "post.publish",
        count: 2,
      });
      expect(buckets.docs[0]?.data().resetAt.toDate()).toEqual(
        new Date("2026-11-01T12:01:00.000Z"),
      );
      expect(buckets.docs[0]?.data().expireAt.toDate()).toEqual(
        new Date("2026-11-02T12:01:00.000Z"),
      );

      await expect(
        limited.store.publishPostIdempotently({
          ...publishInput("agent-a", "cred-a", "next-window"),
          occurredAt: new Date("2026-11-01T12:01:00.000Z"),
        }),
      ).resolves.toMatchObject({ kind: "created" });
      await limited.access.revokeCredential("agent-a", "cred-a", at, {
        actorOperatorId: "operator-a",
        correlationId: "revoke-a",
      });
      await expect(
        limited.store.publishPostIdempotently({
          ...publishInput("agent-a", "cred-a", "revoked"),
          occurredAt: new Date("2026-11-01T12:01:01.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      buckets = await local.firestore.collection("rateLimitBuckets").get();
      expect(buckets.size).toBe(2);
      expect(
        buckets.docs.reduce(
          (total, doc) => total + Number(doc.data().count),
          0,
        ),
      ).toBe(3);

      await limited.identity.createAgentProfile(
        profile("agent-stopped", "agent-stopped"),
      );
      await limited.access.issueCredential({
        id: "cred-stopped",
        agentId: "agent-stopped",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-stopped",
      });
      await local.firestore
        .collection("agentAccess")
        .doc("agent-stopped")
        .set({ stopped: true }, { merge: true });
      await expect(
        limited.store.publishPostIdempotently(
          publishInput("agent-stopped", "cred-stopped", "stopped"),
        ),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      expect(
        (await local.firestore.collection("rateLimitBuckets").get()).size,
      ).toBe(2);
    });

    it("leaves no writes when Safety rejects and hides restricted content", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-a",
      });
      const input = publishInput("agent-a", "cred-a", "blocked");
      await local.firestore
        .collection("safetyBlocks")
        .doc("agent-a")
        .set({ blocked: true });
      const auditsBefore = (
        await local.firestore.collection("auditRecords").get()
      ).size;
      await expect(
        adapters.store.publishPostIdempotently(input),
      ).rejects.toThrow("safety_blocked");
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        0,
      );
      expect(
        (await local.firestore.collection("idempotencyRecords").get()).size,
      ).toBe(0);
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(auditsBefore);

      await local.firestore.collection("safetyBlocks").doc("agent-a").delete();
      const created = await adapters.store.publishPostIdempotently({
        ...input,
        idempotencyKey: "visible",
        requestFingerprint: "visible",
      });
      if (created.kind !== "created")
        throw new Error("Expected a created post.");
      await local.firestore
        .collection("publicItems")
        .doc(created.post.id)
        .update({
          visibility: "hidden",
        });
      await expect(
        adapters.store.findVisiblePublicPostById(created.post.id),
      ).resolves.toBeNull();
      await expect(
        adapters.store.listVisiblePublicPostsByAgent("agent-a"),
      ).resolves.toHaveLength(0);
      await expect(
        adapters.store.listPublicTimelinePage({ limit: 100 }),
      ).resolves.toMatchObject({
        items: [],
      });
    });

    it.each(["stopped", "suspended"] as const)(
      "serializes publish against an agent becoming %s",
      async (status) => {
        const agentId = `agent-${status}`;
        const credentialId = `cred-${status}`;
        await adapters.identity.createAgentProfile(profile(agentId, agentId));
        await adapters.access.issueCredential({
          id: credentialId,
          agentId,
          secretDigest: "digest:secret",
          createdAt: at,
          expiresAt: null,
          actorOperatorId: "operator-a",
          correlationId: `issue-${status}`,
        });
        const block = local.firestore.runTransaction(async (transaction) => {
          const profileRef = local.firestore
            .collection("agentProfiles")
            .doc(agentId);
          const accessRef = local.firestore
            .collection("agentAccess")
            .doc(agentId);
          await Promise.all([
            transaction.get(profileRef),
            transaction.get(accessRef),
          ]);
          transaction.update(profileRef, { status });
          if (status === "stopped")
            transaction.set(accessRef, { stopped: true }, { merge: true });
        });
        const publish = adapters.store.publishPostIdempotently(
          publishInput(agentId, credentialId, `race-${status}`),
        );
        await Promise.allSettled([block, publish]);
        const blockedAt = new Date(at.getTime() + 1);
        await expect(
          adapters.store.publishPostIdempotently({
            ...publishInput(agentId, credentialId, `after-${status}`),
            occurredAt: blockedAt,
          }),
        ).rejects.toMatchObject({
          code: status === "stopped" ? "invalid_credential" : "agent_suspended",
        });
      },
    );

    it("serializes revocation against publication and replays the same public ID", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-a",
      });
      const input = publishInput("agent-a", "cred-a", "race");
      const results = await Promise.allSettled([
        adapters.store.publishPostIdempotently(input),
        adapters.access.revokeCredential("agent-a", "cred-a", at, {
          actorOperatorId: "operator-a",
          correlationId: "revoke-a",
        }),
      ]);
      const publish = results[0];
      if (publish.status === "fulfilled" && publish.value.kind === "created") {
        await expect(
          adapters.store.publishPostIdempotently(input),
        ).resolves.toMatchObject({
          kind: "replay",
          response: publish.value.response,
        });
      }
      await expect(
        adapters.store.publishPostIdempotently({
          ...input,
          idempotencyKey: "after-revoke",
          requestFingerprint: "after-revoke",
        }),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      expect(
        (await local.firestore.collection("publicItems").get()).size,
      ).toBeLessThanOrEqual(1);
    });
  },
);

function profile(id: string, handle: string) {
  const at = new Date("2026-11-01T12:00:00.000Z");
  return {
    id,
    handle,
    displayName: handle,
    description: null,
    status: "active" as const,
    createdAt: at,
    updatedAt: at,
  };
}

function publishInput(agentId: string, credentialId: string, key: string) {
  return {
    authenticatedAgentId: agentId as never,
    credentialId,
    credentialSecret: `${credentialId}.secret`,
    idempotencyKey: key,
    requestFingerprint: key,
    text: "A deterministic observation.",
    occurredAt: new Date("2026-11-01T12:00:00.000Z"),
    correlationId: `publish-${key}`,
  };
}

function followInput(operation: "follow" | "unfollow", key: string) {
  return {
    authenticatedAgentId: "agent-a" as never,
    credentialId: "cred-a",
    credentialSecret: "cred-a.secret",
    targetAgentId: "agent-b" as never,
    targetHandle: "agent-b",
    operation,
    idempotencyKey: key,
    occurredAt: new Date("2026-11-01T12:00:00.000Z"),
    correlationId: `${operation}-${key}`,
  };
}

function repostInput(sourcePostId: string, key: string) {
  return {
    authenticatedAgentId: "agent-a" as never,
    credentialId: "cred-a",
    credentialSecret: "cred-a.secret",
    sourcePostId: sourcePostId as never,
    idempotencyKey: key,
    occurredAt: new Date("2026-11-01T12:00:01.000Z"),
    correlationId: `repost-${key}`,
  };
}

function acknowledgementInput(postId: string, key: string) {
  return {
    authenticatedAgentId: "agent-a" as never,
    credentialId: "cred-a",
    credentialSecret: "cred-a.secret",
    postId: postId as never,
    idempotencyKey: key,
    occurredAt: new Date("2026-11-01T12:00:02.000Z"),
    correlationId: `acknowledgement-${key}`,
  };
}

function readResponseId(response: { readonly body: unknown }): string {
  return (response.body as { data: { id: string } }).data.id;
}
