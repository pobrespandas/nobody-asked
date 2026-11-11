import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLocalFirestoreAdmin,
  resetLocalFirestore,
  type LocalFirestoreAdmin,
} from "@nobody-asked/firestore-support";
import {
  FirestoreAgentInbox,
  INBOX_RETENTION_MS,
  prepareInboxEvent,
  type InboxEventInput,
} from "./agent-inbox.js";
import type { ProfileCaller } from "./agent-profile.js";
import { createFirestoreApiAdapters } from "./firestore-adapters.js";

vi.setConfig({ testTimeout: 20000 });
describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "Agent inbox transactions",
  () => {
    let local: LocalFirestoreAdmin, inbox: FirestoreAgentInbox;
    const at = new Date("2026-11-01T12:00:00Z");
    const caller = (agentId = "alice", when = at): ProfileCaller => ({
      agentId,
      credentialId: `credential-${agentId}`,
      token: `credential-${agentId}.secret`,
      at: when,
    });
    async function seedAgent(id: string) {
      const db = local.firestore,
        stamp = Timestamp.fromDate(at);
      await db.collection("agentProfiles").doc(id).set({
        id,
        handle: id,
        displayName: id.toUpperCase(),
        status: "active",
        createdAt: stamp,
        updatedAt: stamp,
      });
      await db.collection("credentials").doc(`credential-${id}`).set({
        agentId: id,
        secretDigest: "digest:secret",
        createdAt: stamp,
        expiresAt: null,
        revokedAt: null,
      });
      await db
        .collection("agentAccess")
        .doc(id)
        .set({ activeCredentialId: `credential-${id}`, stopped: false });
      await db.collection("handleClaims").doc(id).set({ agentId: id });
    }
    async function event(id: string, overrides: Partial<InboxEventInput> = {}) {
      await local.firestore.runTransaction(async (tx) => {
        const append = await prepareInboxEvent(local.firestore, tx, {
          actionId: id,
          recipientId: "alice",
          actorId: "bob",
          type: "reply.received",
          ...(overrides.type === "follower.added" ? {} : { sourceItemId: id }),
          at,
          ...overrides,
        });
        append();
      });
    }
    async function post(id: string, authorId = "bob") {
      await local.firestore
        .collection("publicItems")
        .doc(id)
        .set({
          id,
          type: "post",
          authorId,
          text: `Message ${id}`,
          visibility: "visible",
          publishedAt: Timestamp.fromDate(at),
          parentId: null,
          conversationRootId: id,
        });
    }
    beforeAll(() => {
      local = createLocalFirestoreAdmin({ appName: "agent-inbox-tests" });
      inbox = new FirestoreAgentInbox(
        local.firestore,
        (secret) => `digest:${secret}`,
      );
    });
    beforeEach(async () => {
      await resetLocalFirestore();
      await seedAgent("alice");
      await seedAgent("bob");
    });
    afterAll(async () => deleteApp(local.app));

    it("allocates one event with its source, rolls back failures and excludes self events", async () => {
      await expect(
        local.firestore.runTransaction(async (tx) => {
          const append = await prepareInboxEvent(local.firestore, tx, {
            actionId: "rolled-back",
            recipientId: "alice",
            actorId: "bob",
            type: "reply.received",
            sourceItemId: "failed-post",
            at,
          });
          append();
          tx.create(
            local.firestore.collection("publicItems").doc("failed-post"),
            { text: "Never commit" },
          );
          throw new Error("source_failed");
        }),
      ).rejects.toThrow("source_failed");
      expect(
        (await local.firestore.collection("agentInboxEvents").get()).size,
      ).toBe(0);
      expect(
        (
          await local.firestore
            .collection("publicItems")
            .doc("failed-post")
            .get()
        ).exists,
      ).toBe(false);
      await event("self", { actorId: "alice" });
      expect(
        (
          await local.firestore
            .collection("agentInboxStates")
            .doc("alice")
            .get()
        ).exists,
      ).toBe(false);
      await post("one");
      await Promise.all([event("one"), event("one")]);
      const events = await local.firestore.collection("agentInboxEvents").get();
      expect(events.size).toBe(1);
      expect(events.docs[0]!.data().sequence).toBe(1);
      expect(JSON.stringify(events.docs[0]!.data())).not.toContain("Message");
      await post("two");
      await Promise.all([
        event("two"),
        event("three", { type: "follower.added" }),
      ]);
      const sequences = (
        await local.firestore.collection("agentInboxEvents").get()
      ).docs
        .map((doc) => doc.data().sequence)
        .sort();
      expect(sequences).toEqual([1, 2, 3]);
    });

    it("paginates under a fixed high water, retains seen state and supports independent sessions", async () => {
      for (const id of ["one", "two", "three"]) {
        await post(id);
        await event(id);
      }
      const first = await inbox.list(caller(), { limit: 1 });
      expect(first.data.map((x) => x.sequence)).toEqual([1]);
      expect(first.page.lastSeenPosition).toBe(0);
      const recreated = new FirestoreAgentInbox(
        local.firestore,
        (secret) => `digest:${secret}`,
      );
      await post("later");
      await event("later");
      const second = await recreated.list(caller(), {
        limit: 1,
        cursor: first.page.nextCursor!,
      });
      const third = await recreated.list(caller(), {
        limit: 1,
        cursor: second.page.nextCursor!,
      });
      expect(second.data.map((x) => x.sequence)).toEqual([2]);
      expect(third.data.map((x) => x.sequence)).toEqual([3]);
      expect(third.page.nextCursor).toBeNull();
      expect(third.page.highWaterMark).toBe(3);
      expect(
        (
          await local.firestore
            .collection("agentInboxStates")
            .doc("alice")
            .get()
        ).data()?.lastSeenPosition,
      ).toBe(0);
      await Promise.all([
        inbox.seen(caller(), third.page.seenThrough, "seen-three"),
        inbox.seen(caller(), first.page.seenThrough, "seen-one"),
      ]);
      expect(
        (
          await local.firestore
            .collection("agentInboxStates")
            .doc("alice")
            .get()
        ).data()?.lastSeenPosition,
      ).toBe(3);
      expect(
        (await inbox.list(caller(), {})).data.map((x) => x.sequence),
      ).toEqual([4]);
      const replay = await inbox.seen(
        caller(),
        third.page.seenThrough,
        "seen-three",
      );
      expect(replay.lastSeenPosition).toBe(3);
      await expect(
        inbox.seen(caller(), first.page.seenThrough, "seen-three"),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        inbox.list(caller(), { limit: 2, cursor: first.page.nextCursor! }),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
    });

    it("replays a saved seen command after its original position token expires", async () => {
      await post("one");
      await event("one");
      const page = await inbox.list(caller(), {});
      const day29 = new Date(at.getTime() + 29 * 86400000);
      const day31 = new Date(at.getTime() + 31 * 86400000);
      const accepted = await inbox.seen(
        caller("alice", day29),
        page.page.seenThrough,
        "delayed-seen",
      );
      expect(accepted.lastSeenPosition).toBe(1);
      expect(
        await inbox.seen(
          caller("alice", day31),
          page.page.seenThrough,
          "delayed-seen",
        ),
      ).toEqual(accepted);
      await expect(
        inbox.seen(
          caller("alice", day31),
          page.page.seenThrough,
          "new-command",
        ),
      ).rejects.toMatchObject({ code: "inbox_position_expired" });
      await local.firestore
        .collection("credentials")
        .doc("credential-alice")
        .update({ revokedAt: Timestamp.fromDate(day31) });
      await expect(
        inbox.seen(
          caller("alice", day31),
          page.page.seenThrough,
          "delayed-seen",
        ),
      ).rejects.toMatchObject({ code: "invalid_credential" });
    });

    it("keeps retention order stable under different process clocks", async () => {
      await post("future");
      await post("older-clock");
      await event("future", { at: new Date(at.getTime() + 60000) });
      await event("older-clock", { at: new Date(at.getTime() - 60000) });
      const rows = (
        await local.firestore
          .collection("agentInboxEvents")
          .orderBy("sequence")
          .get()
      ).docs.map((doc) => doc.data());
      expect((rows[1]!.expireAt as Timestamp).toMillis()).toBe(
        (rows[0]!.expireAt as Timestamp).toMillis(),
      );
      expect(
        (await inbox.list(caller(), {})).data.map((item) => item.sequence),
      ).toEqual([1, 2]);
    });

    it("rejects forged or foreign positions and rechecks Credential state", async () => {
      await post("one");
      await event("one");
      const first = await inbox.list(caller(), { limit: 1 });
      const token = first.page.seenThrough;
      await expect(
        inbox.seen(caller(), token.slice(0, -2) + "xx", "forged"),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
      await inbox.list(caller("bob"), {});
      await expect(
        inbox.seen(caller("bob"), token, "foreign"),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
      await inbox.seen(caller(), token, "saved");
      await local.firestore
        .collection("credentials")
        .doc("credential-alice")
        .update({ revokedAt: Timestamp.fromDate(at) });
      await expect(inbox.seen(caller(), token, "saved")).rejects.toMatchObject({
        code: "invalid_credential",
      });
    });

    it("projects current names and never copies hidden or deleting text", async () => {
      await post("one");
      await event("one");
      const visible = await inbox.list(caller(), {});
      expect(visible.data[0]?.source.text).toBe("Message one");
      expect(visible.data[0]?.actor.displayName).toBe("BOB");
      await local.firestore
        .collection("agentProfiles")
        .doc("bob")
        .update({ displayName: "Changed" });
      await local.firestore
        .collection("publicItems")
        .doc("one")
        .update({ visibility: "hidden", moderationReason: "private reason" });
      const hidden = await inbox.list(caller(), {});
      expect(hidden.data[0]?.actor.displayName).toBe("Changed");
      expect(hidden.data[0]?.source).toEqual({ id: "one", unavailable: true });
      expect(JSON.stringify(hidden)).not.toContain("private reason");
      await local.firestore
        .collection("publicItems")
        .doc("one")
        .update({ visibility: "visible" });
      await local.firestore
        .collection("agentProfiles")
        .doc("bob")
        .update({ deletingAt: Timestamp.fromDate(at) });
      expect((await inbox.list(caller(), {})).data[0]?.source.unavailable).toBe(
        true,
      );
    });

    it("marks a moderated repost unavailable even while its original post stays public", async () => {
      await post("original", "alice");
      await post("repost-record", "bob");
      await local.firestore
        .collection("publicItems")
        .doc("repost-record")
        .update({ type: "repost", sourcePostId: "original" });
      await event("repost-event", {
        type: "post.reposted",
        sourceItemId: "original",
        actionItemId: "repost-record",
      });
      expect((await inbox.list(caller(), {})).data[0]?.source.text).toBe(
        "Message original",
      );
      await local.firestore
        .collection("publicItems")
        .doc("repost-record")
        .update({ visibility: "hidden" });
      const page = await inbox.list(caller(), {});
      expect(page.data[0]?.source).toEqual({
        id: "original",
        unavailable: true,
      });
      expect(JSON.stringify(page)).not.toContain("Message original");
    });

    it("reports expired history explicitly and resumes without requiring physical TTL deletion", async () => {
      await post("old");
      await event("old");
      await post("old-two");
      await event("old-two");
      const old = await inbox.list(caller(), { limit: 1 });
      const later = new Date(at.getTime() + INBOX_RETENTION_MS + 1);
      await post("new");
      await event("new", { at: later });
      let recovery:
        { oldestRetainedPosition: number; restartCursor: string } | undefined;
      await expect(
        inbox.seen(
          caller("alice", later),
          old.page.seenThrough,
          "expired-seen",
        ),
      ).rejects.toMatchObject({ code: "inbox_position_expired" });
      await expect(
        inbox.list(caller("alice", later), {
          limit: 1,
          cursor: old.page.nextCursor!,
        }),
      ).rejects.toMatchObject({ code: "inbox_history_gap" });
      try {
        await inbox.list(caller("alice", later), { limit: 1 });
      } catch (error) {
        recovery = error as typeof recovery;
      }
      expect(recovery?.oldestRetainedPosition).toBe(2);
      expect(recovery?.restartCursor).toBeTypeOf("string");
      const current = await inbox.list(caller("alice", later), {
        limit: 1,
        cursor: recovery!.restartCursor,
      });
      expect(current.data.map((item) => item.id)).toHaveLength(1);
      expect(current.data[0]?.source.id).toBe("new");
      expect(
        (await local.firestore.collection("agentInboxEvents").get()).size,
      ).toBe(3);
    });

    it("enforces independent read/seen limits without counting seen replays", async () => {
      const state = await inbox.list(caller(), {}),
        bucket = Math.floor(at.getTime() / 60000);
      const readId = (await import("./agent-private-access.js")).privateDigest(
        "private:inbox.read:alice",
      );
      await local.firestore
        .collection("rateLimitBuckets")
        .doc(readId)
        .set({ agentId: "alice", bucket, count: 120 });
      await expect(inbox.list(caller(), {})).rejects.toMatchObject({
        code: "rate_limit_exceeded",
        retryAt: "2026-11-01T12:01:00.000Z",
      });
      await inbox.seen(caller(), state.page.seenThrough, "seen-zero");
      const seenId = (await import("./agent-private-access.js")).privateDigest(
        "private:inbox.seen:alice",
      );
      await local.firestore
        .collection("rateLimitBuckets")
        .doc(seenId)
        .set({ agentId: "alice", bucket, count: 60 });
      expect(
        (await inbox.seen(caller(), state.page.seenThrough, "seen-zero"))
          .lastSeenPosition,
      ).toBe(0);
      await expect(
        inbox.seen(caller(), state.page.seenThrough, "new-key"),
      ).rejects.toMatchObject({ code: "rate_limit_exceeded" });
    });

    it("rejects new follows to deleting or deleted recipients without relation or inbox writes", async () => {
      const adapters = createFirestoreApiAdapters({
        firestore: local.firestore,
        digestCredentialSecret: (secret) => `digest:${secret}`,
        safetyPolicy: { async authorizeAgentWrite() {} },
      });
      const target = local.firestore.collection("agentProfiles").doc("alice");
      for (const marker of ["deletingAt", "deletedAt"]) {
        await target.update({
          deletingAt: null,
          deletedAt: null,
          [marker]: Timestamp.fromDate(at),
        });
        await expect(
          adapters.store.changeFollowIdempotently({
            authenticatedAgentId: "bob" as never,
            credentialId: "credential-bob",
            credentialSecret: "credential-bob.secret",
            targetAgentId: "alice" as never,
            targetHandle: "alice",
            operation: "follow",
            idempotencyKey: `follow-${marker}`,
            occurredAt: at,
            correlationId: `follow-${marker}`,
          }),
        ).rejects.toMatchObject({ code: "agent_not_found" });
        expect((await local.firestore.collection("follows").get()).size).toBe(
          0,
        );
        expect(
          (await local.firestore.collection("agentInboxEvents").get()).size,
        ).toBe(0);
        expect((await target.get()).data()?.[marker]).toEqual(
          Timestamp.fromDate(at),
        );
      }
    });

    it("hooks real reply, follow and repost mutations into only their direct recipient inbox", async () => {
      const adapters = createFirestoreApiAdapters({
        firestore: local.firestore,
        digestCredentialSecret: (secret) => `digest:${secret}`,
        safetyPolicy: { async authorizeAgentWrite() {} },
      });
      const root = await adapters.store.publishPostIdempotently({
        authenticatedAgentId: "alice" as never,
        credentialId: "credential-alice",
        credentialSecret: "credential-alice.secret",
        text: "Root",
        idempotencyKey: "root",
        requestFingerprint: "root",
        occurredAt: at,
        correlationId: "root",
      });
      const rootId = String(
        (root.response.body as { data: { id: string } }).data.id,
      );
      const reply = await adapters.store.publishReplyIdempotently({
        authenticatedAgentId: "bob" as never,
        credentialId: "credential-bob",
        credentialSecret: "credential-bob.secret",
        parentPostId: rootId as never,
        text: "Reply",
        idempotencyKey: "reply",
        requestFingerprint: "reply",
        occurredAt: at,
        correlationId: "reply",
      });
      await adapters.store.changeFollowIdempotently({
        authenticatedAgentId: "bob" as never,
        credentialId: "credential-bob",
        credentialSecret: "credential-bob.secret",
        targetAgentId: "alice" as never,
        targetHandle: "alice",
        operation: "follow",
        idempotencyKey: "follow",
        occurredAt: at,
        correlationId: "follow",
      });
      await adapters.store.repostIdempotently({
        authenticatedAgentId: "bob" as never,
        credentialId: "credential-bob",
        credentialSecret: "credential-bob.secret",
        sourcePostId: rootId as never,
        idempotencyKey: "repost",
        occurredAt: at,
        correlationId: "repost",
      });
      const result = await inbox.list(caller(), {});
      expect(result.data.map((item) => item.type)).toEqual([
        "reply.received",
        "follower.added",
        "post.reposted",
      ]);
      expect((await inbox.list(caller("bob"), {})).data).toEqual([]);
      const replyId = String(
        (reply.response.body as { data: { id: string } }).data.id,
      );
      await adapters.store.publishReplyIdempotently({
        authenticatedAgentId: "alice" as never,
        credentialId: "credential-alice",
        credentialSecret: "credential-alice.secret",
        parentPostId: replyId as never,
        text: "Direct nested reply",
        idempotencyKey: "nested",
        requestFingerprint: "nested",
        occurredAt: at,
        correlationId: "nested",
      });
      expect(
        (await inbox.list(caller("bob"), {})).data.map((item) => item.type),
      ).toEqual(["reply.received"]);
      expect((await inbox.list(caller(), {})).data).toHaveLength(3);
      await adapters.store.changeFollowIdempotently({
        authenticatedAgentId: "bob" as never,
        credentialId: "credential-bob",
        credentialSecret: "credential-bob.secret",
        targetAgentId: "alice" as never,
        targetHandle: "alice",
        operation: "follow",
        idempotencyKey: "already-following",
        occurredAt: at,
        correlationId: "already-following",
      });
      await adapters.store.repostIdempotently({
        authenticatedAgentId: "bob" as never,
        credentialId: "credential-bob",
        credentialSecret: "credential-bob.secret",
        sourcePostId: rootId as never,
        idempotencyKey: "already-reposted",
        occurredAt: at,
        correlationId: "already-reposted",
      });
      expect((await inbox.list(caller(), {})).data).toHaveLength(3);
    });
  },
);
