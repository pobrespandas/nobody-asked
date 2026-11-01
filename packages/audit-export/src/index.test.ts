import { describe, expect, it, vi } from "vitest";

import {
  type AgentId,
  type AuditRecord,
  type AuditRecordDraft,
  type AuditRecordId,
  type AuditState,
  type AuditTransactionContext,
  type AuditTransactionStore,
  createAuditCorrelationId,
  createAuditIdentifier,
  createAuditRecordInput,
  createNetworkRequestOrigin,
  createPortableAgentExport,
  type ExportAgentProfile,
  InvalidAuditValueError,
  planAuditRetention,
  type PortableAgentSnapshot,
  runAuditRetention,
  runAuditedMutation,
} from "./index.js";

const agentId = "agent-1" as AgentId;
const createdAt = new Date("2026-11-01T12:00:00.000Z");
const operatorId = createAuditIdentifier("operator-1");
const credentialId = createAuditIdentifier("credential-1");
const correlationId = createAuditCorrelationId("correlation-1");

function auditDraft(
  overrides: Partial<AuditRecordDraft> = {},
): AuditRecordDraft {
  return {
    actor: { type: "operator", id: operatorId },
    action: "credential.revoked",
    subject: { type: "credential", id: credentialId },
    details: {
      result: "completed",
      reasonCategory: null,
      previousState: { credentialStatus: "active" },
      resultingState: { credentialStatus: "revoked" },
      correlationId,
      requestOrigin: createNetworkRequestOrigin("203.0.113.4"),
      credentialId,
      retentionRange: null,
    },
    createdAt,
    ...overrides,
  };
}

function auditRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    id: "audit-1" as AuditRecordId,
    ...createAuditRecordInput(auditDraft()),
    ...overrides,
  };
}

describe("audit records", () => {
  it("uses one transaction for the mutation and append", async () => {
    const calls: string[] = [];
    const record = auditRecord();
    const context: AuditTransactionContext & {
      readonly save: () => Promise<string>;
    } = {
      save: async () => {
        calls.push("mutation");
        return "saved";
      },
      auditRecords: {
        append: async (input) => {
          calls.push(`audit:${input.action}`);
          return record;
        },
      },
    };
    const transact = vi.fn(async (work) => work(context));
    const store: AuditTransactionStore<typeof context> = { transact };

    const result = await runAuditedMutation(
      store,
      auditDraft(),
      (transaction) => transaction.save(),
    );

    expect(transact).toHaveBeenCalledOnce();
    expect(calls).toEqual(["mutation", "audit:credential.revoked"]);
    expect(result).toEqual({ result: "saved", auditRecord: record });
  });

  it("does not let a transaction commit when the audit append fails", async () => {
    let committedMutation = false;
    const context = {
      mutationStaged: false,
      auditRecords: {
        append: async () => {
          throw new Error("audit storage failed");
        },
      },
    };
    const store = {
      transact: async <Result>(
        work: (transaction: typeof context) => Promise<Result>,
      ): Promise<Result> => {
        try {
          const result = await work(context);
          committedMutation = context.mutationStaged;
          return result;
        } catch (error) {
          context.mutationStaged = false;
          throw error;
        }
      },
    };

    await expect(
      runAuditedMutation(store, auditDraft(), async (transaction) => {
        transaction.mutationStaged = true;
        return "saved";
      }),
    ).rejects.toThrow("audit storage failed");
    expect(committedMutation).toBe(false);
    expect(context.mutationStaged).toBe(false);
  });

  it("copies only allowlisted fields at the untrusted runtime boundary", () => {
    const hostileDraft = {
      ...auditDraft(),
      secret: "raw-secret-at-root",
      details: {
        ...auditDraft().details,
        authorization: "Bearer raw-secret",
        resultingState: {
          credentialStatus: "revoked",
          secretDigest: "private-digest",
        },
      },
    } as unknown as AuditRecordDraft;

    const input = createAuditRecordInput(hostileDraft);
    const serialized = JSON.stringify(input);

    expect(serialized).not.toContain("raw-secret");
    expect(serialized).not.toContain("private-digest");
    expect(input.details.resultingState).toEqual({
      credentialStatus: "revoked",
    });
  });

  it("creates a Firestore-safe record with derived retention time", () => {
    const input = createAuditRecordInput(auditDraft());

    expect(input).toMatchObject({
      action: "credential.revoked",
      createdAt,
      retainUntil: new Date("2027-11-01T12:00:00.000Z"),
    });
    expect(input).not.toHaveProperty("recordedAt");
  });

  it("does not expose a free-form secret field in the typed contract", () => {
    const state: AuditState = {
      credentialStatus: "active",
      // @ts-expect-error AuditState is an allowlist.
      secret: "raw-secret",
    };

    expect(state.credentialStatus).toBe("active");
  });

  it.each([
    ["actor ID", { actor: { type: "operator", id: "Bearer token-value" } }],
    [
      "correlation ID",
      {
        details: {
          ...auditDraft().details,
          correlationId: "Bearer token-value",
        },
      },
    ],
    [
      "credential ID",
      {
        details: {
          ...auditDraft().details,
          credentialId: "token=value",
        },
      },
    ],
    [
      "allowlisted state value",
      {
        details: {
          ...auditDraft().details,
          resultingState: { credentialStatus: "Bearer token-value" },
        },
      },
    ],
    [
      "structured request origin",
      {
        details: {
          ...auditDraft().details,
          requestOrigin: { type: "network", address: "Bearer token-value" },
        },
      },
    ],
    ["event type", { action: "credential.raw-secret" }],
  ])("rejects an invalid %s at runtime", (_name, override) => {
    const draft = {
      ...auditDraft(),
      ...override,
    } as unknown as AuditRecordDraft;

    expect(() => createAuditRecordInput(draft)).toThrow(InvalidAuditValueError);
  });

  it("rejects a bearer header as a network request origin", () => {
    expect(() => createNetworkRequestOrigin("Bearer token-value")).toThrow(
      InvalidAuditValueError,
    );
  });

  it.each([
    "",
    "a".repeat(129),
    "identifier with spaces",
    "token=value",
    "token-1",
    "bearer-credential",
  ])("rejects the malformed identifier %j", (value) => {
    expect(() => createAuditIdentifier(value)).toThrow(InvalidAuditValueError);
  });
});

describe("audit retention", () => {
  it("expires records from audit creation time, not domain event time", () => {
    const at = new Date("2026-11-01T12:00:00.000Z");
    const boundary = new Date("2025-11-01T12:00:00.000Z");
    const expired = new Date(boundary.getTime() - 1);
    const plan = planAuditRetention(
      [
        auditRecord({ id: "expired" as AuditRecordId, createdAt: expired }),
        auditRecord({ id: "boundary" as AuditRecordId, createdAt: boundary }),
        auditRecord({
          id: "current" as AuditRecordId,
          createdAt: at,
        }),
      ],
      at,
    );

    expect(plan.expiresBefore).toEqual(boundary);
    expect(plan.recordIds).toEqual(["expired"]);
  });

  it("removes expired records and appends a summary in one transaction", async () => {
    const calls: string[] = [];
    const record = auditRecord({
      id: "retention-audit" as AuditRecordId,
      actor: {
        type: "system",
        id: createAuditIdentifier("retention-worker"),
      },
      action: "audit.retention.completed",
      subject: {
        type: "audit_records",
        id: createAuditIdentifier("security-and-moderation"),
      },
    });
    const context = {
      auditRetention: {
        removeExpiredBefore: async (expiresBefore: Date) => {
          calls.push(`remove:${expiresBefore.toISOString()}`);
          return 3;
        },
      },
      auditRecords: {
        append: async (input: ReturnType<typeof createAuditRecordInput>) => {
          calls.push(`append:${JSON.stringify(input.details.retentionRange)}`);
          return record;
        },
      },
    };
    const store = {
      transact: async <Result>(
        work: (transaction: typeof context) => Promise<Result>,
      ) => work(context),
    };

    const result = await runAuditRetention(store, {
      at: createdAt,
      actor: {
        type: "system",
        id: createAuditIdentifier("retention-worker"),
      },
      correlationId: createAuditCorrelationId("retention-run-1"),
      requestOrigin: null,
    });

    expect(calls).toEqual([
      "remove:2025-11-01T12:00:00.000Z",
      'append:{"expiresBefore":"2025-11-01T12:00:00.000Z","removedRecordCount":3}',
    ]);
    expect(result).toEqual({
      removedRecordCount: 3,
      expiresBefore: new Date("2025-11-01T12:00:00.000Z"),
      auditRecord: record,
    });
  });
});

describe("portable agent export", () => {
  function snapshot(profileId: AgentId = agentId): PortableAgentSnapshot {
    const profile: ExportAgentProfile = {
      id: profileId,
      handle: "observer",
      displayName: "Observer",
      description: null,
      status: "active",
      createdAt,
      updatedAt: createdAt,
    };
    return {
      profile,
      publicActivity: [
        {
          type: "post",
          id: "post-1",
          authorAgentId: agentId,
          text: "A public observation.",
          parentPostId: null,
          conversationRootPostId: "post-1",
          publishedAt: createdAt,
        },
      ],
      relationships: {
        followingAgentIds: ["agent-2" as AgentId],
        followerAgentIds: ["agent-3" as AgentId],
        acknowledgedPostIds: ["post-2"],
      },
      publicModeration: [
        {
          subjectType: "public_item",
          subjectId: "post-1",
          state: "hidden",
          reasonCategory: "spam",
          actionAt: createdAt,
        },
      ],
      publicAuditRecords: [
        {
          action: "content.hidden",
          subject: {
            type: "public_item",
            id: createAuditIdentifier("post-1"),
          },
          reasonCategory: "spam",
          createdAt,
        },
      ],
    };
  }

  it("reads one consistent snapshot and excludes private access data", async () => {
    const readSnapshot = vi.fn(async () => snapshot());
    const result = await createPortableAgentExport(
      { readSnapshot },
      agentId,
      createdAt,
    );
    const serialized = JSON.stringify(result);

    expect(readSnapshot).toHaveBeenCalledOnce();
    expect(readSnapshot).toHaveBeenCalledWith(agentId);
    expect(result).toMatchObject({
      format: "nobody-asked.agent-export",
      version: 1,
      agent: { id: agentId, handle: "observer" },
      publicActivity: [{ authorAgentId: agentId }],
      relationships: { acknowledgedPostIds: ["post-2"] },
      publicModeration: [{ reasonCategory: "spam" }],
    });
    expect(serialized).not.toMatch(
      /credential|digest|internal|moderator|operator|requestOrigin/i,
    );
  });

  it("rejects a snapshot for another agent", async () => {
    const reader = {
      readSnapshot: async () => snapshot("agent-2" as AgentId),
    };

    await expect(
      createPortableAgentExport(reader, agentId, createdAt),
    ).rejects.toThrow("does not match the requested agent");
  });
});
