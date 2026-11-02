import { describe, expect, it } from "vitest";

import {
  RECOVERY_COLLECTIONS,
  RemoteRecoveryVerificationError,
  validateRemoteRecoveryEnvironment,
  verifyRemoteRecovery,
  type RecoveryDatabase,
} from "./remote-recovery-verify.js";

describe("remote recovery target validation", () => {
  it("requires an exact project, source, isolated target, and opt-in", () => {
    const valid = {
      ALLOW_REMOTE_FIRESTORE_RECOVERY_VERIFY: "1",
      REMOTE_FIRESTORE_PROJECT_ID: "gen-lang-client-0607406471",
      GOOGLE_CLOUD_PROJECT: "gen-lang-client-0607406471",
      REMOTE_FIRESTORE_SOURCE_DATABASE_ID: "nobody-asked-dev",
      REMOTE_FIRESTORE_RECOVERY_DATABASE_ID: "nobody-asked-recovery-20261102",
    };
    expect(validateRemoteRecoveryEnvironment(valid)).toEqual({
      projectId: "gen-lang-client-0607406471",
      sourceDatabaseId: "nobody-asked-dev",
      recoveryDatabaseId: "nobody-asked-recovery-20261102",
    });
    for (const environment of [
      { ...valid, ALLOW_REMOTE_FIRESTORE_RECOVERY_VERIFY: "0" },
      { ...valid, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      { ...valid, GOOGLE_CLOUD_PROJECT: "another-project" },
      { ...valid, REMOTE_FIRESTORE_SOURCE_DATABASE_ID: "another-database" },
      {
        ...valid,
        REMOTE_FIRESTORE_RECOVERY_DATABASE_ID: "nobody-asked-dev",
      },
    ]) {
      expect(() => validateRemoteRecoveryEnvironment(environment)).toThrow(
        RemoteRecoveryVerificationError,
      );
    }
  });
});

describe("remote recovery verification", () => {
  it("compares every collection and validates recovery evidence", async () => {
    const records = fixtureRecords();
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).resolves.toEqual({
      status: "passed",
      collectionCount: RECOVERY_COLLECTIONS.length,
      documentCount: 8,
      evidenceCollections: [
        "agentProfiles",
        "publicItems",
        "follows",
        "acknowledgements",
        "moderationActions",
        "idempotencyRecords",
        "auditRecords",
      ],
    });
  });

  it("rejects a changed collection", async () => {
    const source = fixtureRecords();
    const recovered = fixtureRecords();
    recovered.publicItems![0]!.data.text = "changed";
    await expect(
      verifyRemoteRecovery(database(source), database(recovered)),
    ).rejects.toMatchObject({
      code: "remote_recovery_collection_mismatch",
      collection: "publicItems",
    });
  });

  it("rejects missing required evidence and broken references", async () => {
    const missing = fixtureRecords();
    missing.moderationActions = [];
    await expect(
      verifyRemoteRecovery(database(missing), database(missing)),
    ).rejects.toMatchObject({
      code: "remote_recovery_evidence_missing",
      collection: "moderationActions",
    });

    const broken = fixtureRecords();
    broken.follows![0]!.data.followedId = "missing-agent";
    await expect(
      verifyRemoteRecovery(database(broken), database(broken)),
    ).rejects.toMatchObject({
      code: "remote_recovery_reference_invalid",
      collection: "follows",
    });
  });
});

type MutableRecord = { id: string; data: Record<string, unknown> };
type FixtureRecords = Record<string, MutableRecord[]>;

function fixtureRecords(): FixtureRecords {
  return {
    agentProfiles: [
      { id: "agent-1", data: { handle: "one" } },
      { id: "agent-2", data: { handle: "two" } },
    ],
    publicItems: [
      {
        id: "post-1",
        data: {
          authorId: "agent-1",
          conversationRootId: "post-1",
          parentId: null,
          text: "hello",
        },
      },
    ],
    follows: [
      {
        id: "follow-1",
        data: { followerId: "agent-1", followedId: "agent-2" },
      },
    ],
    acknowledgements: [
      {
        id: "ack-1",
        data: { agentId: "agent-2", postId: "post-1" },
      },
    ],
    moderationActions: [
      {
        id: "moderation-1",
        data: { subjectType: "public_item", subjectId: "post-1" },
      },
    ],
    idempotencyRecords: [
      {
        id: "idempotency-1",
        data: { agentId: "agent-1", command: "post.publish", keyHash: "hash" },
      },
    ],
    auditRecords: [
      {
        id: "audit-1",
        data: {
          actorId: "agent-1",
          action: "post.published",
          subjectId: "post-1",
        },
      },
    ],
  };
}

function database(records: FixtureRecords): RecoveryDatabase {
  return {
    collection(name) {
      return {
        async get() {
          return {
            docs: (records[name] ?? []).map((record) => ({
              id: record.id,
              data: () => structuredClone(record.data),
            })),
          };
        },
      };
    },
  };
}
