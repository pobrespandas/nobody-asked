import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  Timestamp,
  type Firestore,
  type Transaction,
  type DocumentSnapshot,
} from "firebase-admin/firestore";
import type { ProfileCaller } from "./agent-profile.js";
import {
  PrivateAgentError,
  privateDigest,
  privateRate,
  privateRequire,
  requirePrivateAgent,
} from "./agent-private-access.js";

export const PRIVATE_MEMORY_LIMITS = Object.freeze({
  notes: 64,
  noteBytes: 8192,
  totalBytes: 131072,
  defaultPage: 25,
  maxPage: 100,
});
export interface MemoryMetadata {
  key: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  bytes: number;
}
export interface MemoryNote extends MemoryMetadata {
  text: string;
}
export interface MemoryPage {
  items: MemoryMetadata[];
  nextCursor: string | null;
}
export interface PrivateMemoryExport {
  format: "nobody-asked.private-memory";
  formatVersion: 1;
  agentId: string;
  exportedAt: string;
  notes: MemoryNote[];
}
export interface MemoryDeletionEntry {
  id: string;
  targetType: "memory";
  targetId: string;
  agentId: string;
  incarnation: string;
  requestedAt: string;
}
export interface MemoryDeletionLedger {
  writeDeletion(entry: MemoryDeletionEntry): Promise<void>;
}
export interface MemoryCondition {
  createOnly?: boolean;
  version?: string;
}
export interface MemoryMutation {
  metadata: MemoryMetadata;
  created: boolean;
}
export interface MemoryDeleted {
  key: string;
  deleted: true;
  version: string;
}
export interface AgentMemoryOperations {
  list(
    caller: ProfileCaller,
    options?: { limit?: number; cursor?: string | null },
  ): Promise<MemoryPage>;
  get(caller: ProfileCaller, key: string): Promise<MemoryNote>;
  put(
    caller: ProfileCaller,
    key: string,
    text: string,
    condition: MemoryCondition,
    idempotencyKey: string,
  ): Promise<MemoryMutation>;
  delete(
    caller: ProfileCaller,
    key: string,
    version: string,
    idempotencyKey: string,
  ): Promise<MemoryDeleted>;
  export(caller: ProfileCaller): Promise<PrivateMemoryExport>;
}
export function validateMemoryKey(key: string): string {
  privateRequire(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(key) &&
      !["__proto__", "prototype", "constructor"].includes(key),
    400,
    "invalid_input",
  );
  return key;
}
export const memoryDocumentId = (agentId: string, key: string) =>
  privateDigest(`memory:${agentId}:${key}`);
function iso(value: unknown): string {
  return value instanceof Timestamp
    ? value.toDate().toISOString()
    : String(value);
}
function metadata(data: Record<string, unknown>): MemoryMetadata {
  return {
    key: String(data.key),
    version: String(data.version),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    bytes: Number(data.bytes),
  };
}
function note(data: Record<string, unknown>): MemoryNote {
  return { ...metadata(data), text: String(data.text) };
}
function signer(value: unknown): string {
  return typeof value === "string"
    ? value
    : randomBytes(32).toString("base64url");
}
function cursor(value: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
function decodeCursor(token: string, secret: string): Record<string, unknown> {
  privateRequire(token.length <= 1024, 400, "invalid_cursor");
  const [body, signature, ...extra] = token.split(".");
  privateRequire(body && signature && !extra.length, 400, "invalid_cursor");
  const expected = createHmac("sha256", secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new PrivateAgentError(400, "invalid_cursor");
  }
  privateRequire(
    actual.length === expected.length && timingSafeEqual(actual, expected),
    400,
    "invalid_cursor",
  );
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    privateRequire(
      value && typeof value === "object" && !Array.isArray(value),
      400,
      "invalid_cursor",
    );
    return value;
  } catch {
    throw new PrivateAgentError(400, "invalid_cursor");
  }
}
function commandKey(agentId: string, operation: string, key: string): string {
  privateRequire(
    /^[\x21-\x7E]{1,180}$/.test(key),
    400,
    "idempotency_key_required",
  );
  return privateDigest(`memory-command:${agentId}:${operation}:${key}`);
}
function saveAudit(
  transaction: Transaction,
  firestore: Firestore,
  caller: ProfileCaller,
  key: string,
  action: string,
  commandId: string,
): void {
  transaction.create(
    firestore
      .collection("auditRecords")
      .doc(privateDigest(`memory-audit:${commandId}`)),
    {
      actorType: "agent",
      actorId: caller.agentId,
      action,
      subjectType: "private_memory",
      subjectId: key,
      details: { result: "completed" },
      createdAt: Timestamp.fromDate(caller.at),
      expireAt: Timestamp.fromMillis(caller.at.getTime() + 365 * 86400000),
    },
  );
}
function active(snapshot: DocumentSnapshot): boolean {
  return snapshot.exists && !snapshot.data()?.deleting;
}
const commandExpiry = (at: Date) =>
  Timestamp.fromMillis(at.getTime() + 30 * 86400000);

export class FirestoreAgentMemory implements AgentMemoryOperations {
  constructor(
    readonly firestore: Firestore,
    readonly digestSecret: (secret: string) => string | Promise<string>,
    readonly ledger: MemoryDeletionLedger | null = null,
  ) {}
  async get(caller: ProfileCaller, key: string): Promise<MemoryNote> {
    validateMemoryKey(key);
    return this.firestore.runTransaction(async (transaction) => {
      await requirePrivateAgent(
        transaction,
        this.firestore,
        this.digestSecret,
        caller,
      );
      const saved = await transaction.get(
        this.firestore
          .collection("agentMemoryNotes")
          .doc(memoryDocumentId(caller.agentId, key)),
      );
      const rate = await privateRate(
        transaction,
        this.firestore,
        caller,
        "memory.read",
        120,
      );
      privateRequire(active(saved), 404, "memory_note_not_found");
      rate();
      return note(saved.data()!);
    });
  }
  async list(
    caller: ProfileCaller,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<MemoryPage> {
    const limit = options.limit ?? 25;
    privateRequire(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      400,
      "invalid_input",
    );
    return this.firestore.runTransaction(async (transaction) => {
      await requirePrivateAgent(
        transaction,
        this.firestore,
        this.digestSecret,
        caller,
      );
      const stateRef = this.firestore
        .collection("agentMemoryStates")
        .doc(caller.agentId);
      const [state, notes] = await Promise.all([
        transaction.get(stateRef),
        transaction.get(
          this.firestore
            .collection("agentMemoryNotes")
            .where("agentId", "==", caller.agentId)
            .limit(65),
        ),
      ]);
      privateRequire(notes.size <= 64, 500, "memory_state_invalid");
      const data = state.data() ?? {},
        secret = signer(data.signingKey),
        epoch = Number(data.epoch ?? 0);
      let after = "";
      if (options.cursor) {
        const token = decodeCursor(options.cursor, secret);
        privateRequire(
          token.owner === caller.agentId &&
            token.limit === limit &&
            typeof token.after === "string",
          400,
          "invalid_cursor",
        );
        privateRequire(token.epoch === epoch, 409, "record_conflict");
        after = token.after;
      }
      const rate = await privateRate(
        transaction,
        this.firestore,
        caller,
        "memory.read",
        120,
      );
      const sorted = notes.docs
        .filter(active)
        .map((s) => metadata(s.data()))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .filter((item) => item.key > after);
      const items = sorted.slice(0, limit);
      rate();
      if (!state.exists)
        transaction.create(stateRef, {
          agentId: caller.agentId,
          signingKey: secret,
          epoch: 0,
          count: notes.size,
          bytes: notes.docs.reduce(
            (sum, item) => sum + Number(item.data().bytes ?? 0),
            0,
          ),
        });
      return {
        items,
        nextCursor:
          sorted.length > limit
            ? cursor(
                {
                  owner: caller.agentId,
                  epoch,
                  limit,
                  after: items.at(-1)!.key,
                },
                secret,
              )
            : null,
      };
    });
  }
  async export(caller: ProfileCaller): Promise<PrivateMemoryExport> {
    return this.firestore.runTransaction(async (transaction) => {
      await requirePrivateAgent(
        transaction,
        this.firestore,
        this.digestSecret,
        caller,
      );
      const saved = await transaction.get(
        this.firestore
          .collection("agentMemoryNotes")
          .where("agentId", "==", caller.agentId)
          .limit(65),
      );
      privateRequire(saved.size <= 64, 500, "memory_state_invalid");
      const rate = await privateRate(
        transaction,
        this.firestore,
        caller,
        "memory.export",
        5,
        3600000,
      );
      const notes = saved.docs
        .filter(active)
        .map((item) => note(item.data()))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      rate();
      return {
        format: "nobody-asked.private-memory",
        formatVersion: 1,
        agentId: caller.agentId,
        exportedAt: caller.at.toISOString(),
        notes,
      };
    });
  }
  async put(
    caller: ProfileCaller,
    key: string,
    text: string,
    condition: MemoryCondition,
    idempotencyKey: string,
  ): Promise<MemoryMutation> {
    validateMemoryKey(key);
    privateRequire(typeof text === "string", 400, "invalid_input");
    privateRequire(
      ![...text].some(
        (character) =>
          character.length === 1 &&
          character.charCodeAt(0) >= 0xd800 &&
          character.charCodeAt(0) <= 0xdfff,
      ),
      400,
      "invalid_input",
    );
    const bytes = Buffer.byteLength(text, "utf8");
    privateRequire(bytes <= 8192, 422, "memory_note_too_large");
    privateRequire(
      condition.createOnly === true
        ? condition.version === undefined
        : typeof condition.version === "string" && condition.version.length > 0,
      428,
      "precondition_required",
    );
    const noteId = memoryDocumentId(caller.agentId, key),
      id = commandKey(caller.agentId, "put", idempotencyKey),
      fingerprint = privateDigest(
        JSON.stringify({
          key,
          text,
          createOnly: condition.createOnly === true,
          version: condition.version ?? null,
        }),
      );
    return this.firestore.runTransaction(async (transaction) => {
      await requirePrivateAgent(
        transaction,
        this.firestore,
        this.digestSecret,
        caller,
      );
      const noteRef = this.firestore.collection("agentMemoryNotes").doc(noteId),
        stateRef = this.firestore
          .collection("agentMemoryStates")
          .doc(caller.agentId),
        commandRef = this.firestore.collection("agentMemoryCommands").doc(id);
      const [saved, state, command] = await Promise.all([
        transaction.get(noteRef),
        transaction.get(stateRef),
        transaction.get(commandRef),
      ]);
      if (command.exists) {
        privateRequire(
          command.data()?.fingerprint === fingerprint,
          409,
          "idempotency_conflict",
        );
        return command.data()!.response as MemoryMutation;
      }
      const data = saved.data(),
        stateData = state.data() ?? {};
      privateRequire(!data?.deleting, 409, "record_conflict");
      privateRequire(
        condition.createOnly === true
          ? !saved.exists
          : saved.exists && data?.version === condition.version,
        409,
        "record_conflict",
      );
      const count = Number(stateData.count ?? 0) + (saved.exists ? 0 : 1),
        total = Number(stateData.bytes ?? 0) - Number(data?.bytes ?? 0) + bytes;
      privateRequire(
        count <= 64 && total <= 131072,
        409,
        "memory_quota_exceeded",
      );
      const rate = await privateRate(
          transaction,
          this.firestore,
          caller,
          "memory.mutate",
          60,
        ),
        stamp = Timestamp.fromDate(caller.at);
      const record = {
        agentId: caller.agentId,
        key,
        text,
        bytes,
        incarnation: data?.incarnation ?? randomUUID(),
        version: randomUUID(),
        createdAt: data?.createdAt ?? stamp,
        updatedAt: stamp,
      };
      const response: MemoryMutation = {
        metadata: metadata(record),
        created: !saved.exists,
      };
      rate();
      transaction.set(noteRef, record);
      transaction.set(stateRef, {
        agentId: caller.agentId,
        count,
        bytes: total,
        epoch: Number(stateData.epoch ?? 0) + 1,
        signingKey: signer(stateData.signingKey),
      });
      transaction.create(commandRef, {
        agentId: caller.agentId,
        noteId,
        fingerprint,
        response,
        createdAt: stamp,
        expireAt: commandExpiry(caller.at),
      });
      saveAudit(
        transaction,
        this.firestore,
        caller,
        key,
        saved.exists ? "memory.updated" : "memory.created",
        id,
      );
      return response;
    });
  }
  async delete(
    caller: ProfileCaller,
    key: string,
    version: string,
    idempotencyKey: string,
  ): Promise<MemoryDeleted> {
    validateMemoryKey(key);
    privateRequire(this.ledger, 503, "memory_deletion_unavailable");
    privateRequire(
      typeof version === "string" && version.length > 0,
      428,
      "precondition_required",
    );
    const noteId = memoryDocumentId(caller.agentId, key),
      id = commandKey(caller.agentId, "delete", idempotencyKey),
      fingerprint = privateDigest(JSON.stringify({ key, version }));
    const commandRef = this.firestore.collection("agentMemoryCommands").doc(id);
    const accepted = await this.firestore.runTransaction(
      async (transaction) => {
        await requirePrivateAgent(
          transaction,
          this.firestore,
          this.digestSecret,
          caller,
        );
        const noteRef = this.firestore
          .collection("agentMemoryNotes")
          .doc(noteId);
        const stateRef = this.firestore
          .collection("agentMemoryStates")
          .doc(caller.agentId);
        const [saved, command, state] = await Promise.all([
          transaction.get(noteRef),
          transaction.get(commandRef),
          transaction.get(stateRef),
        ]);
        if (command.exists) {
          privateRequire(
            command.data()?.fingerprint === fingerprint,
            409,
            "idempotency_conflict",
          );
          return command.data() as {
            entry: MemoryDeletionEntry;
            response: MemoryDeleted;
            completed?: boolean;
          };
        }
        privateRequire(
          active(saved) && saved.data()?.version === version,
          409,
          "record_conflict",
        );
        privateRequire(state.exists, 500, "memory_state_invalid");
        const rate = await privateRate(
          transaction,
          this.firestore,
          caller,
          "memory.mutate",
          60,
        );
        const entry: MemoryDeletionEntry = {
          id: privateDigest(`memory-delete:${id}`),
          targetType: "memory",
          targetId: noteId,
          agentId: caller.agentId,
          incarnation: String(saved.data()!.incarnation),
          requestedAt: caller.at.toISOString(),
        };
        const response: MemoryDeleted = {
          key,
          deleted: true,
          version: randomUUID(),
        };
        const intent = {
          agentId: caller.agentId,
          noteId,
          fingerprint,
          entry,
          response,
          completed: false,
          createdAt: Timestamp.fromDate(caller.at),
        };
        rate();
        transaction.update(noteRef, { deleting: entry.id });
        transaction.update(stateRef, {
          epoch: Number(state.data()?.epoch ?? 0) + 1,
        });
        transaction.create(commandRef, intent);
        return intent;
      },
    );
    if (accepted.completed) return accepted.response;
    // Firestore map order is not stable. Keep immutable ledger bytes stable on retry.
    const entry: MemoryDeletionEntry = {
      id: accepted.entry.id,
      targetType: "memory",
      targetId: accepted.entry.targetId,
      agentId: accepted.entry.agentId,
      incarnation: accepted.entry.incarnation,
      requestedAt: accepted.entry.requestedAt,
    };
    try {
      await this.ledger.writeDeletion(entry);
      await applyMemoryDeletionLedgerEntry(this.firestore, entry, caller.at);
      await this.firestore.runTransaction(async (transaction) => {
        const saved = await transaction.get(commandRef);
        if (saved.exists && !saved.data()?.completed) {
          transaction.update(commandRef, {
            completed: true,
            expireAt: commandExpiry(caller.at),
          });
          saveAudit(
            transaction,
            this.firestore,
            caller,
            key,
            "memory.deleted",
            id,
          );
        }
      });
    } catch {
      throw new PrivateAgentError(503, "memory_deletion_pending");
    }
    return accepted.response;
  }
}

/** Apply only the deleted incarnation. A later recreation of the same key remains intact. */
export async function applyMemoryDeletionLedgerEntry(
  firestore: Firestore,
  entry: MemoryDeletionEntry,
  at = new Date(),
): Promise<boolean> {
  privateRequire(
    entry.targetType === "memory" &&
      /^[a-f0-9]{64}$/.test(entry.targetId) &&
      /^[a-f0-9]{64}$/.test(entry.id) &&
      typeof entry.agentId === "string" &&
      !entry.agentId.includes("/") &&
      typeof entry.incarnation === "string" &&
      entry.incarnation.length > 0 &&
      Number.isFinite(new Date(entry.requestedAt).getTime()),
    400,
    "invalid_memory_deletion",
  );
  return firestore.runTransaction(async (transaction) => {
    const ref = firestore.collection("agentMemoryNotes").doc(entry.targetId),
      stateRef = firestore.collection("agentMemoryStates").doc(entry.agentId);
    const [saved, state, notes] = await Promise.all([
      transaction.get(ref),
      transaction.get(stateRef),
      transaction.get(
        firestore
          .collection("agentMemoryNotes")
          .where("agentId", "==", entry.agentId)
          .limit(65),
      ),
    ]);
    privateRequire(notes.size <= 64, 500, "memory_state_invalid");
    const matches =
      saved.exists &&
      saved.data()?.agentId === entry.agentId &&
      saved.data()?.incarnation === entry.incarnation;
    if (matches) {
      const remaining = notes.docs.filter((item) => item.id !== entry.targetId);
      const data = state.data() ?? {};
      transaction.delete(ref);
      transaction.set(stateRef, {
        agentId: entry.agentId,
        count: remaining.length,
        bytes: remaining.reduce(
          (sum, item) => sum + Number(item.data().bytes ?? 0),
          0,
        ),
        epoch: Number(data.epoch ?? 0) + 1,
        signingKey: signer(data.signingKey),
      });
    }
    transaction.set(
      firestore.collection("agentMemoryTombstones").doc(entry.id),
      { ...entry, appliedAt: Timestamp.fromDate(at) },
    );
    return matches;
  });
}
export const applyMemoryDeletion = applyMemoryDeletionLedgerEntry;
