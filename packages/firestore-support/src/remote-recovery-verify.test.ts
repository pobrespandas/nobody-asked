import { readFileSync } from "node:fs";
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
  it("includes every autonomous identity collection and Operator challenges", () => {
    expect(RECOVERY_COLLECTIONS).toEqual(
      expect.arrayContaining([
        "agentRegistrations",
        "agentRecoveryKeys",
        "agentRecoveryChallenges",
        "registrationControls",
        "operatorChallenges",
        "agentOperatorAuthority",
        "agentOperatorAuthorizations",
      ]),
    );
  });

  it("covers the persistence collection inventory", () => {
    const source = readFileSync(
      new URL("../../persistence/src/firestore-adapters.ts", import.meta.url),
      "utf8",
    );
    const declaration = source.match(
      /const collections = \{([\s\S]*?)\} as const;/,
    )?.[1];
    expect(declaration).toBeDefined();
    const names = [...declaration!.matchAll(/:\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(RECOVERY_COLLECTIONS).toEqual(expect.arrayContaining(names));
  });

  it.each([
    "agentRegistrations",
    "agentRecoveryKeys",
    "agentRecoveryChallenges",
    "registrationControls",
    "operatorChallenges",
    "agentOperatorAuthority",
    "agentOperatorAuthorizations",
  ])("rejects missing or tampered %s records", async (collection) => {
    const source = fixtureRecords();
    source[collection] = [
      { id: "identity-record", data: { marker: "original" } },
    ];
    for (const replacement of [
      [],
      [{ id: "identity-record", data: { marker: "tampered" } }],
    ]) {
      const recovered = structuredClone(source);
      recovered[collection] = replacement;
      await expect(
        verifyRemoteRecovery(database(source), database(recovered)),
      ).rejects.toMatchObject({
        code: "remote_recovery_collection_mismatch",
        collection,
      });
    }
  });

  it("validates autonomous identity links even when both snapshots have the same missing key", async () => {
    const records = fixtureRecords();
    records.credentials = [
      { id: "credential-1", data: { agentId: "agent-1" } },
    ];
    records.agentRecoveryKeys = [
      { id: "agent-1", data: { publicKey: { kty: "OKP" } } },
    ];
    records.agentRegistrations = [
      {
        id: "registration-1",
        data: {
          consumedAt: "completed",
          agentId: "agent-1",
          credentialId: "credential-1",
        },
      },
    ];
    records.agentRecoveryChallenges = [
      { id: "challenge-1", data: { agentId: "agent-1" } },
    ];
    records.registrationControls = [
      { id: "global", data: { pending: [{ id: "registration-1" }] } },
    ];
    records.idempotencyRecords!.push({
      id: "registration-result",
      data: {
        command: "POST /v1/agent-registrations/{registrationId}/complete",
        agentId: "agent-1",
        requestFingerprint: "fingerprint",
      },
    });
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).resolves.toMatchObject({ status: "passed" });
    records.agentRecoveryKeys = [];
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).rejects.toMatchObject({
      code: "remote_recovery_reference_invalid",
      collection: "agentRegistrations",
    });
  });
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

  it("checks the stored idempotency variants without allowing unknown recovery commands", async () => {
    for (const data of [
      {
        actorId: "operator-1",
        command: "POST /v1/operator/invitations",
        keyHash: "hash",
        requestFingerprint: "fingerprint",
      },
      {
        agentId: "agent-1",
        command: "agent-recovery:stop_agent",
        requestFingerprint: "fingerprint",
      },
    ]) {
      const records = fixtureRecords();
      records.idempotencyRecords!.push({ id: "variant", data });
      await expect(
        verifyRemoteRecovery(database(records), database(records)),
      ).resolves.toMatchObject({ status: "passed" });
      delete (data as Record<string, unknown>).requestFingerprint;
      await expect(
        verifyRemoteRecovery(database(records), database(records)),
      ).rejects.toMatchObject({
        code: "remote_recovery_reference_invalid",
        collection: "idempotencyRecords",
      });
    }
    const records = fixtureRecords();
    records.idempotencyRecords!.push({
      id: "unknown",
      data: {
        agentId: "agent-1",
        command: "agent-recovery:unknown",
        requestFingerprint: "fingerprint",
      },
    });
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).rejects.toMatchObject({
      code: "remote_recovery_reference_invalid",
      collection: "idempotencyRecords",
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

  it("recovers private authorization history and Agent or Operator replay actors", async () => {
    const records = authorizationRecords();
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).resolves.toMatchObject({ status: "passed" });
    const recovered = structuredClone(records);
    recovered.agentOperatorAuthorizations![0]!.data.operatorId =
      "another-operator";
    await expect(
      verifyRemoteRecovery(database(records), database(recovered)),
    ).rejects.toMatchObject({
      code: "remote_recovery_collection_mismatch",
      collection: "agentOperatorAuthorizations",
    });
  });

  it("validates new authorization rate actors without interpreting legacy buckets as authorization records", async () => {
    const records = authorizationRecords();
    records.rateLimitBuckets = [
      {
        id: "legacy",
        data: { agentId: "legacy-actor", command: "post.publish", count: 1 },
      },
    ];
    for (const operation of ["create", "remove", "accept"] as const)
      records.rateLimitBuckets.push({
        id: operation,
        data: {
          command: `operator_authorization.${operation}`,
          actorKind: operation === "accept" ? "operator" : "agent",
          actorId: operation === "accept" ? "operator-1" : "agent-1",
        },
      });
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).resolves.toMatchObject({ status: "passed" });
    records.rateLimitBuckets.find(
      (value) => value.id === "accept",
    )!.data.actorId = "agent-1";
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).rejects.toMatchObject({
      code: "remote_recovery_reference_invalid",
      collection: "rateLimitBuckets",
    });
  });

  it.each([
    "missing-request",
    "wrong-agent",
    "wrong-operator",
    "revoked-active",
    "unaccepted-active",
    "pending-revision",
  ])("rejects invalid authorization authority: %s", async (kind) => {
    const records = authorizationRecords();
    const authority = records.agentOperatorAuthority![0]!.data;
    const request = records.agentOperatorAuthorizations![0]!.data;
    if (kind === "missing-request") records.agentOperatorAuthorizations = [];
    if (kind === "wrong-agent") request.agentId = "agent-2";
    if (kind === "wrong-operator") authority.operatorId = "missing-operator";
    if (kind === "revoked-active") request.revokedAt = "revoked";
    if (kind === "unaccepted-active") request.acceptedAt = null;
    if (kind === "pending-revision") {
      authority.operatorId = null;
      authority.activeAuthorizationId = null;
      authority.pendingAuthorizationId = "authorization-1";
      request.acceptedAt = null;
    }
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).rejects.toMatchObject({
      code: "remote_recovery_reference_invalid",
      collection: "agentOperatorAuthority",
    });
  });

  it("keeps pending and removed authorization history without requiring current profile ownership", async () => {
    const records = authorizationRecords();
    const authority = records.agentOperatorAuthority![0]!.data;
    const request = records.agentOperatorAuthorizations![0]!.data;
    authority.revision = 1;
    authority.operatorId = null;
    authority.activeAuthorizationId = null;
    authority.pendingAuthorizationId = "authorization-1";
    request.acceptedAt = null;
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).resolves.toMatchObject({ status: "passed" });
    authority.revision = 2;
    authority.pendingAuthorizationId = null;
    request.revokedAt = "revoked";
    await expect(
      verifyRemoteRecovery(database(records), database(records)),
    ).resolves.toMatchObject({ status: "passed" });
  });

  it.each(["actor", "keyHash", "requestFingerprint", "response", "command"])(
    "rejects invalid authorization replay %s",
    async (field) => {
      const records = authorizationRecords();
      const replay = records.idempotencyRecords!.find(
        (x) => x.id === "accept-result",
      )!.data;
      if (field === "actor") replay.actorId = "agent-1";
      else if (field === "command")
        replay.command = "operator-authorization:unknown";
      else delete replay[field];
      await expect(
        verifyRemoteRecovery(database(records), database(records)),
      ).rejects.toMatchObject({ code: "remote_recovery_reference_invalid" });
    },
  );

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

function authorizationRecords(): FixtureRecords {
  const records = fixtureRecords();
  records.operators = [{ id: "operator-1", data: { active: true } }];
  records.credentials = [{ id: "credential-1", data: { agentId: "agent-1" } }];
  records.agentOperatorAuthority = [
    {
      id: "agent-1",
      data: {
        agentId: "agent-1",
        revision: 2,
        pendingAuthorizationId: null,
        operatorId: "operator-1",
        activeAuthorizationId: "authorization-1",
      },
    },
  ];
  records.agentOperatorAuthorizations = [
    {
      id: "authorization-1",
      data: {
        agentId: "agent-1",
        operatorId: "operator-1",
        revision: 1,
        requesterCredentialId: "credential-1",
        acceptedAt: "accepted",
        revokedAt: null,
      },
    },
  ];
  for (const operation of ["create", "remove", "accept"]) {
    records.idempotencyRecords!.push({
      id: `${operation}-result`,
      data: {
        actorId: operation === "accept" ? "operator-1" : "agent-1",
        command: `operator-authorization:${operation}`,
        keyHash: "hash",
        requestFingerprint: "fingerprint",
        response: {
          status: operation === "create" ? 201 : 200,
          body: { data: { agentId: "agent-1" } },
        },
      },
    });
  }
  records.idempotencyRecords!.push({
    id: "signed-removal",
    data: {
      agentId: "agent-1",
      command: "agent-recovery:remove_operator_authorization",
      requestFingerprint: "fingerprint",
    },
  });
  return records;
}

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
