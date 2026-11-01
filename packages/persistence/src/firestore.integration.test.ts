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
        writes: 4,
      });
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
