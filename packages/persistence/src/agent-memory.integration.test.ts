import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import {
  beforeAll,
  beforeEach,
  afterAll,
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
  FirestoreAgentMemory,
  applyMemoryDeletion,
  memoryDocumentId,
  type MemoryDeletionEntry,
} from "./agent-memory.js";
import type { ProfileCaller } from "./agent-profile.js";
vi.setConfig({ testTimeout: 20000 });
describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "Agent-private memory persistence",
  () => {
    let local: LocalFirestoreAdmin, memory: FirestoreAgentMemory;
    let ledger: MemoryDeletionEntry[] = [];
    let failLedger = false;
    const at = new Date("2026-11-11T12:00:00Z");
    const caller: ProfileCaller = {
      agentId: "memory-agent",
      credentialId: "memory-credential",
      token: "memory-credential.secret",
      at,
    };
    beforeAll(() => {
      local = createLocalFirestoreAdmin({ appName: "memory-continuity-tests" });
    });
    beforeEach(async () => {
      await resetLocalFirestore();
      ledger = [];
      failLedger = false;
      await local.firestore
        .collection("agentProfiles")
        .doc(caller.agentId)
        .set({ status: "active" });
      await local.firestore
        .collection("credentials")
        .doc(caller.credentialId)
        .set({
          agentId: caller.agentId,
          secretDigest: "digest:secret",
          createdAt: Timestamp.fromDate(at),
          revokedAt: null,
          expiresAt: null,
        });
      await local.firestore
        .collection("agentAccess")
        .doc(caller.agentId)
        .set({ activeCredentialId: caller.credentialId, stopped: false });
      memory = new FirestoreAgentMemory(local.firestore, (s) => `digest:${s}`, {
        async writeDeletion(entry) {
          if (failLedger) throw Error("object store down");
          const existing = ledger.find((item) => item.id === entry.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(entry))
            throw Error("immutable ledger conflict");
          if (!existing) ledger.push(entry);
        },
      });
    });
    afterAll(async () => deleteApp(local.app));
    it("keeps text out of metadata, replay and audit while applying conditional versions", async () => {
      const first = await memory.put(
        caller,
        "working-context",
        "private-body-token",
        { createOnly: true },
        "create",
      );
      expect(first.created).toBe(true);
      expect(JSON.stringify(first)).not.toContain("private-body-token");
      expect(await memory.get(caller, "working-context")).toMatchObject({
        text: "private-body-token",
        version: first.metadata.version,
      });
      expect(
        await memory.put(
          caller,
          "working-context",
          "private-body-token",
          { createOnly: true },
          "create",
        ),
      ).toEqual(first);
      await expect(
        memory.put(
          caller,
          "working-context",
          "other",
          { createOnly: true },
          "create",
        ),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      const results = await Promise.allSettled([
        memory.put(
          caller,
          "working-context",
          "one",
          { version: first.metadata.version },
          "one",
        ),
        memory.put(
          caller,
          "working-context",
          "two",
          { version: first.metadata.version },
          "two",
        ),
      ]);
      expect(
        results.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(results.find((item) => item.status === "rejected")).toMatchObject({
        reason: { code: "record_conflict" },
      });
      const commands = await local.firestore
          .collection("agentMemoryCommands")
          .get(),
        audit = await local.firestore.collection("auditRecords").get();
      expect(
        JSON.stringify(
          [...commands.docs, ...audit.docs].map((item) => item.data()),
        ),
      ).not.toContain("private-body-token");
    });
    it("enforces ownership, current Credentials and the Agent state on reads and replay", async () => {
      await memory.put(
        caller,
        "context",
        "owned",
        { createOnly: true },
        "create",
      );
      await expect(
        memory.get({ ...caller, agentId: "someone-else" }, "context"),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      await local.firestore
        .collection("agentProfiles")
        .doc(caller.agentId)
        .update({ status: "suspended" });
      await expect(memory.export(caller)).rejects.toMatchObject({
        code: "agent_suspended",
      });
      await local.firestore
        .collection("agentProfiles")
        .doc(caller.agentId)
        .update({ status: "active" });
      await local.firestore
        .collection("credentials")
        .doc(caller.credentialId)
        .update({ revokedAt: Timestamp.fromDate(at) });
      await expect(
        memory.put(caller, "context", "owned", { createOnly: true }, "create"),
      ).rejects.toMatchObject({ code: "invalid_credential" });
    });
    it("counts UTF-8 bytes and never exceeds total quota under concurrent writes", async () => {
      await expect(
        memory.put(
          caller,
          "invalid-unicode",
          "\ud800",
          { createOnly: true },
          "invalid-unicode",
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      const exact = "😀".repeat(2048);
      const first = await memory.put(
        caller,
        "emoji",
        exact,
        { createOnly: true },
        "emoji",
      );
      expect(first.metadata.bytes).toBe(8192);
      await expect(
        memory.put(
          caller,
          "too-large",
          exact + "😀",
          { createOnly: true },
          "large",
        ),
      ).rejects.toMatchObject({ code: "memory_note_too_large" });
      for (let index = 0; index < 14; index++)
        await memory.put(
          caller,
          `note-${index}`,
          "x".repeat(8192),
          { createOnly: true },
          `create-${index}`,
        );
      const results = await Promise.allSettled([
        memory.put(
          caller,
          "last-one",
          "x".repeat(8192),
          { createOnly: true },
          "last-one",
        ),
        memory.put(
          caller,
          "last-two",
          "x".repeat(8192),
          { createOnly: true },
          "last-two",
        ),
      ]);
      expect(
        results.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(results.find((item) => item.status === "rejected")).toMatchObject({
        reason: { code: "memory_quota_exceeded" },
      });
      expect(
        (
          await local.firestore
            .collection("agentMemoryStates")
            .doc(caller.agentId)
            .get()
        ).data()?.bytes,
      ).toBe(131072);
    });
    it("enforces the note count independently of text bytes", async () => {
      for (let index = 0; index < 64; index++) {
        const time =
          index < 60 ? caller.at : new Date(caller.at.getTime() + 60000);
        await memory.put(
          { ...caller, at: time },
          `empty-${index}`,
          "",
          { createOnly: true },
          `empty-${index}`,
        );
      }
      await expect(
        memory.put(
          { ...caller, at: new Date(caller.at.getTime() + 60000) },
          "one-too-many",
          "",
          { createOnly: true },
          "too-many",
        ),
      ).rejects.toMatchObject({ code: "memory_quota_exceeded" });
      expect(
        (
          await local.firestore
            .collection("agentMemoryStates")
            .doc(caller.agentId)
            .get()
        ).data(),
      ).toMatchObject({ count: 64, bytes: 0 });
    });

    it("paginates metadata with owner-bound cursors and exports one consistent set", async () => {
      for (const key of ["zeta", "alpha", "middle"])
        await memory.put(caller, key, `text-${key}`, { createOnly: true }, key);
      const first = await memory.list(caller, { limit: 2 });
      expect(first.items.map((item) => item.key)).toEqual(["alpha", "middle"]);
      expect(JSON.stringify(first)).not.toContain("text-");
      const second = await memory.list(caller, {
        limit: 2,
        cursor: first.nextCursor,
      });
      expect(second.items.map((item) => item.key)).toEqual(["zeta"]);
      const otherProcess = new FirestoreAgentMemory(
        local.firestore,
        (s) => `digest:${s}`,
      );
      expect(
        await otherProcess.list(caller, { limit: 2, cursor: first.nextCursor }),
      ).toEqual(second);
      await expect(
        memory.list(caller, {
          limit: 2,
          cursor: first.nextCursor!.replace(/^./, "!"),
        }),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
      const exported = await memory.export(caller);
      expect(exported.format).toBe("nobody-asked.private-memory");
      expect(exported.notes.map((item) => item.text)).toEqual([
        "text-alpha",
        "text-middle",
        "text-zeta",
      ]);
      await memory.put(caller, "later", "new", { createOnly: true }, "later");
      await expect(
        memory.list(caller, { limit: 2, cursor: first.nextCursor }),
      ).rejects.toMatchObject({ code: "record_conflict" });
    });
    it("persists a non-text deletion intent, retries the ledger and preserves a later incarnation", async () => {
      const first = await memory.put(
        caller,
        "context",
        "deleted-body-token",
        { createOnly: true },
        "create",
      );
      failLedger = true;
      await expect(
        memory.delete(caller, "context", first.metadata.version, "delete"),
      ).rejects.toMatchObject({ code: "memory_deletion_pending" });
      await expect(memory.get(caller, "context")).rejects.toMatchObject({
        code: "memory_note_not_found",
      });
      await expect(
        memory.put(
          caller,
          "context",
          "new",
          { createOnly: true },
          "new-before-delete",
        ),
      ).rejects.toMatchObject({ code: "record_conflict" });
      const pending = await local.firestore
        .collection("agentMemoryCommands")
        .where("noteId", "==", memoryDocumentId(caller.agentId, "context"))
        .get();
      expect(
        pending.docs.find((item) => item.data().entry)?.data().expireAt,
      ).toBeUndefined();
      failLedger = false;
      const deletion = await memory.delete(
        caller,
        "context",
        first.metadata.version,
        "delete",
      );
      expect(deletion.deleted).toBe(true);
      expect(ledger).toHaveLength(1);
      expect(
        await memory.delete(
          caller,
          "context",
          first.metadata.version,
          "delete",
        ),
      ).toEqual(deletion);
      const recreated = await memory.put(
        caller,
        "context",
        "new-body",
        { createOnly: true },
        "recreate",
      );
      expect(recreated.metadata.version).not.toBe(first.metadata.version);
      await expect(
        memory.put(
          caller,
          "context",
          "stale",
          { version: first.metadata.version },
          "stale",
        ),
      ).rejects.toMatchObject({ code: "record_conflict" });
      expect(await applyMemoryDeletion(local.firestore, ledger[0]!)).toBe(
        false,
      );
      expect((await memory.get(caller, "context")).text).toBe("new-body");
      const tombstones = await local.firestore
        .collection("agentMemoryTombstones")
        .get();
      expect(
        JSON.stringify(tombstones.docs.map((item) => item.data())),
      ).not.toContain("deleted-body-token");
    });
    it("recovers an accepted deletion after the independent ledger succeeds but its checkpoint fails", async () => {
      const created = await memory.put(
        caller,
        "checkpoint",
        "must-stay-deleted",
        { createOnly: true },
        "create-checkpoint",
      );
      let failOnce = true;
      const interrupted = new FirestoreAgentMemory(
        local.firestore,
        (s) => `digest:${s}`,
        {
          async writeDeletion(entry) {
            if (!ledger.some((item) => item.id === entry.id))
              ledger.push(entry);
            if (failOnce) {
              failOnce = false;
              vi.spyOn(local.firestore, "runTransaction").mockRejectedValueOnce(
                Error("checkpoint failure"),
              );
            }
          },
        },
      );
      try {
        await expect(
          interrupted.delete(
            caller,
            "checkpoint",
            created.metadata.version,
            "checkpoint-delete",
          ),
        ).rejects.toMatchObject({ code: "memory_deletion_pending" });
      } finally {
        vi.restoreAllMocks();
      }
      expect(ledger).toHaveLength(1);
      await expect(memory.get(caller, "checkpoint")).rejects.toMatchObject({
        code: "memory_note_not_found",
      });
      expect(await applyMemoryDeletion(local.firestore, ledger[0]!)).toBe(true);
      expect(
        (
          await interrupted.delete(
            caller,
            "checkpoint",
            created.metadata.version,
            "checkpoint-delete",
          )
        ).deleted,
      ).toBe(true);
      expect(
        (
          await local.firestore
            .collection("agentMemoryNotes")
            .doc(memoryDocumentId(caller.agentId, "checkpoint"))
            .get()
        ).exists,
      ).toBe(false);
    });

    it("reconciles the exact deleted incarnation restored from an older backup", async () => {
      const original = await memory.put(
        caller,
        "context",
        "old-private-body",
        { createOnly: true },
        "create",
      );
      const ref = local.firestore
          .collection("agentMemoryNotes")
          .doc(memoryDocumentId(caller.agentId, "context")),
        backup = (await ref.get()).data()!;
      await memory.delete(
        caller,
        "context",
        original.metadata.version,
        "delete",
      );
      await ref.set(backup);
      expect(await applyMemoryDeletion(local.firestore, ledger[0]!)).toBe(true);
      expect((await ref.get()).exists).toBe(false);
      expect(
        (
          await local.firestore
            .collection("agentMemoryStates")
            .doc(caller.agentId)
            .get()
        ).data(),
      ).toMatchObject({ count: 0, bytes: 0 });
      expect(await applyMemoryDeletion(local.firestore, ledger[0]!)).toBe(
        false,
      );
    });
  },
);
