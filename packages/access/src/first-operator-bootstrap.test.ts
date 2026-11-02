import { createHash, timingSafeEqual } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  bootstrapFirstOperator,
  FirstModeratorAlreadyGrantedError,
  type BootstrapAuditRecord,
  type FirstOperatorBootstrapRecord,
  type FirstOperatorBootstrapState,
  type FirstOperatorBootstrapStore,
  type FirstOperatorBootstrapTransaction,
  type ModeratorAuthorityRecord,
  type OperatorInvitationRecord,
  type OperatorRecord,
} from "./first-operator-bootstrap.js";

const at = new Date("2026-11-02T01:00:00.000Z");
const rawSecret = "local-test-invitation-secret";

describe("first operator and moderator bootstrap", () => {
  it("consumes one verified invitation and stores only its digest", async () => {
    const store = new MemoryBootstrapStore(invitation());

    const result = await run(store);

    expect(result).toMatchObject({
      changed: true,
      operatorId: "operator-first",
      moderatorAuthorityGranted: true,
    });
    expect(store.operator).toMatchObject({
      id: "operator-first",
      normalizedIdentity: "first@example.test",
    });
    expect(store.authority).toMatchObject({ operatorId: "operator-first" });
    expect(store.audits.map((record) => record.action)).toEqual([
      "operator.enrolled",
      "moderator.authority_granted",
    ]);
    expect(JSON.stringify(store)).not.toContain(rawSecret);
    expect(store.invitation.secretDigest).toBe(digest(rawSecret));
  });

  it("replays the completed result without duplicate authority or audit", async () => {
    const store = new MemoryBootstrapStore(invitation());
    const first = await run(store);
    const second = await run(store);

    expect(first.changed).toBe(true);
    expect(second).toEqual({ ...first, changed: false });
    expect(store.authorityWrites).toBe(1);
    expect(store.operatorWrites).toBe(1);
    expect(store.audits).toHaveLength(2);
  });

  it("rejects another first moderator after the one-time grant", async () => {
    const store = new MemoryBootstrapStore(invitation());
    await run(store);

    await expect(
      run(store, {
        invitationId: "invitation-other",
        operatorId: "operator-other",
      }),
    ).rejects.toBeInstanceOf(FirstModeratorAlreadyGrantedError);
    expect(store.authorityWrites).toBe(1);
  });
});

function run(
  store: FirstOperatorBootstrapStore,
  override: Partial<{
    invitationId: string;
    operatorId: string;
  }> = {},
) {
  return bootstrapFirstOperator(
    {
      store,
      digestSecret: digest,
      digestsMatch(left, right) {
        const leftBuffer = Buffer.from(left);
        const rightBuffer = Buffer.from(right);
        return (
          leftBuffer.length === rightBuffer.length &&
          timingSafeEqual(leftBuffer, rightBuffer)
        );
      },
      now: () => new Date(at),
    },
    {
      invitationId: override.invitationId ?? "invitation-first",
      invitationSecret: rawSecret,
      operatorId: override.operatorId ?? "operator-first",
      correlationId: "bootstrap-first",
    },
  );
}

function invitation(): OperatorInvitationRecord {
  return {
    id: "invitation-first",
    intendedIdentity: "first@example.test",
    secretDigest: digest(rawSecret),
    expiresAt: new Date("2026-11-03T01:00:00.000Z"),
    recipientProofAt: new Date("2026-11-02T00:59:00.000Z"),
    acceptedAt: null,
    acceptedOperatorId: null,
    revokedAt: null,
  };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

class MemoryBootstrapStore implements FirstOperatorBootstrapStore {
  operator: OperatorRecord | null = null;
  authority: ModeratorAuthorityRecord | null = null;
  bootstrap: FirstOperatorBootstrapRecord | null = null;
  audits: BootstrapAuditRecord[] = [];
  operatorWrites = 0;
  authorityWrites = 0;

  constructor(public invitation: OperatorInvitationRecord) {}

  async transact<Result>(
    work: (transaction: FirstOperatorBootstrapTransaction) => Promise<Result>,
  ): Promise<Result> {
    const staged: (() => void)[] = [];
    const transaction: FirstOperatorBootstrapTransaction = {
      readState: async (invitationId, operatorId) =>
        Object.freeze({
          invitation:
            invitationId === this.invitation.id ? this.invitation : null,
          bootstrap: this.bootstrap,
          operator: operatorId === this.operator?.id ? this.operator : null,
          moderatorAuthority:
            operatorId === this.authority?.operatorId ? this.authority : null,
          anyModeratorAuthority: this.authority,
        } satisfies FirstOperatorBootstrapState),
      acceptInvitation: (record) =>
        staged.push(() => {
          this.invitation = record;
        }),
      createOperator: (record) =>
        staged.push(() => {
          this.operator = record;
          this.operatorWrites += 1;
        }),
      createModeratorAuthority: (record) =>
        staged.push(() => {
          this.authority = record;
          this.authorityWrites += 1;
        }),
      createBootstrapRecord: (record) =>
        staged.push(() => {
          this.bootstrap = record;
        }),
      createAuditRecord: (record) =>
        staged.push(() => {
          this.audits.push(record);
        }),
    };
    const result = await work(transaction);
    for (const commit of staged) commit();
    return result;
  }
}
