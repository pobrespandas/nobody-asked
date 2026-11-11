import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { expect, it } from "vitest";
import { FirestoreAgentProfiles } from "./agent-profile.js";

type Data = Record<string, unknown>;
function fixture() {
  const at = new Date("2026-11-11T12:00:00Z");
  const created = Timestamp.fromDate(at);
  const records = new Map<string, Data>([
    [
      "agentProfiles/agent",
      {
        handle: "agent",
        displayName: "Agent",
        description: null,
        status: "active",
        createdAt: created,
        updatedAt: created,
      },
    ],
    [
      "credentials/credential",
      { agentId: "agent", secretDigest: "digest:secret", revokedAt: null },
    ],
    ["agentAccess/agent", { activeCredentialId: "credential", stopped: false }],
  ]);
  const database = {
    collection: (name: string) => ({
      doc: (id: string) => ({ path: `${name}/${id}`, id }),
    }),
    async runTransaction<T>(
      run: (transaction: unknown) => Promise<T>,
    ): Promise<T> {
      const writes: Array<() => void> = [];
      const transaction = {
        async get(ref: { path: string; id: string }) {
          const data = records.get(ref.path);
          return {
            exists: data !== undefined,
            id: ref.id,
            data: () => data,
            updateTime: created,
          };
        },
        update(ref: { path: string }, data: Data) {
          writes.push(() =>
            records.set(ref.path, { ...records.get(ref.path), ...data }),
          );
        },
        set(ref: { path: string }, data: Data) {
          writes.push(() => records.set(ref.path, data));
        },
        create(ref: { path: string }, data: Data) {
          writes.push(() => records.set(ref.path, data));
        },
      };
      const result = await run(transaction);
      for (const write of writes) write();
      return result;
    },
  } as unknown as Firestore;
  return {
    at,
    records,
    operations: new FirestoreAgentProfiles(
      database,
      (value) => `digest:${value}`,
    ),
  };
}
it("expires profile replay snapshots and rechecks authority before replay", async () => {
  const { at, records, operations } = fixture();
  const caller = {
    agentId: "agent",
    credentialId: "credential",
    token: "credential.secret",
    at,
  };
  const read = await operations.read(caller);
  const changed = await operations.update(
    caller,
    { description: "Updated biography" },
    read.version,
    "change",
  );
  const saved = [...records.entries()].find(([path]) =>
    path.startsWith("idempotencyRecords/"),
  )![1];
  expect((saved.expireAt as Timestamp).toDate().toISOString()).toBe(
    "2026-12-11T12:00:00.000Z",
  );
  expect(
    await operations.update(
      caller,
      { description: "Updated biography" },
      read.version,
      "change",
    ),
  ).toEqual(changed);
  records.set("credentials/credential", {
    ...records.get("credentials/credential"),
    revokedAt: Timestamp.fromDate(at),
  });
  await expect(
    operations.update(
      caller,
      { description: "Updated biography" },
      read.version,
      "change",
    ),
  ).rejects.toMatchObject({ status: 401, code: "invalid_credential" });
});
