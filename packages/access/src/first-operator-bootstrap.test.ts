import { createHash, timingSafeEqual } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  bootstrapFirstOperator,
  bootstrapEnrolledOperator,
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
import type { OperatorSessionRecord } from "./operator-session.js";

const at = new Date("2026-11-02T01:00:00.000Z");
const rawSecret = "local-test-invitation-secret";

describe("first operator and moderator bootstrap", () => {
  it("grants the first authority to the Operator already enrolled from the matching invitation", async () => {
    const store = new MemoryBootstrapStore(invitation());
    store.invitation = {
      ...store.invitation,
      acceptedAt: at,
      acceptedOperatorId: "operator-first",
    };
    store.operator = {
      id: "operator-first",
      normalizedIdentity: "first@example.test",
      sourceInvitationId: "invitation-first",
      createdAt: at,
    };
    expect(await runEnrolled(store)).toMatchObject({
      changed: true,
      operatorId: "operator-first",
    });
    expect(store.operatorWrites).toBe(0);
    expect(store.audits.map((record) => record.action)).toEqual([
      "moderator.authority_granted",
    ]);
  });
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

  it("replays a completed bootstrap after invitation expiry without another grant", async () => {
    const store = new MemoryBootstrapStore(invitation());
    const first = await run(store);
    const replay = await run(store, {
      now: new Date("2026-11-04T01:00:00.000Z"),
    });
    expect(replay).toEqual({ ...first, changed: false });
    expect(store.authorityWrites).toBe(1);
    expect(store.operatorWrites).toBe(1);
    expect(store.audits).toHaveLength(2);
  });

  it("still rejects an expired invitation before the first grant", async () => {
    const store = new MemoryBootstrapStore(invitation());
    await expect(
      run(store, { now: new Date("2026-11-04T01:00:00.000Z") }),
    ).rejects.toMatchObject({ code: "bootstrap_invitation_rejected" });
    expect(store.authorityWrites).toBe(0);
    expect(store.audits).toHaveLength(0);
  });

  it("supports a valid historical acceptance after invitation expiry with a current session, and replays", async () => {
    const store = enrolledStore();
    store.invitation = {
      ...store.invitation,
      expiresAt: new Date(at.getTime() - 1000),
      acceptedAt: new Date(at.getTime() - 2000),
      recipientProofAt: new Date(at.getTime() - 3000),
    };
    const first = await runEnrolled(store);
    expect(await runEnrolled(store)).toEqual({ ...first, changed: false });
    expect(store.operatorWrites).toBe(0);
    expect(store.authorityWrites).toBe(1);
    expect(store.audits).toHaveLength(1);
    store.session = { ...store.session!, revokedAt: at };
    await expect(runEnrolled(store)).rejects.toMatchObject({
      code: "bootstrap_invitation_rejected",
    });
  });

  it.each([
    "missing-session",
    "wrong-session-operator",
    "wrong-origin",
    "wrong-secret",
    "stale-session",
    "future-session",
    "expired-session",
    "revoked-session",
    "inactive-operator",
    "revoked-operator",
    "wrong-identity",
    "wrong-source",
    "wrong-accepted-operator",
    "missing-proof",
    "unaccepted",
    "late-acceptance",
  ])("rejects enrolled bootstrap %s without writes", async (kind) => {
    const store = enrolledStore();
    if (kind === "missing-session") store.session = null;
    if (kind === "wrong-session-operator")
      store.session = { ...store.session!, operatorId: "another-operator" };
    if (kind === "wrong-origin")
      store.session = { ...store.session!, origin: "https://another.test" };
    if (kind === "wrong-secret")
      store.session = { ...store.session!, secretDigest: digest("other") };
    if (kind === "stale-session")
      store.session = {
        ...store.session!,
        authenticatedAt: new Date(at.getTime() - 600001),
      };
    if (kind === "future-session")
      store.session = {
        ...store.session!,
        authenticatedAt: new Date(at.getTime() + 1),
      };
    if (kind === "expired-session")
      store.session = { ...store.session!, expiresAt: at };
    if (kind === "revoked-session")
      store.session = { ...store.session!, revokedAt: at };
    if (kind === "inactive-operator")
      store.operator = { ...store.operator!, active: false };
    if (kind === "revoked-operator")
      store.operator = { ...store.operator!, revokedAt: at };
    if (kind === "wrong-identity")
      store.operator = {
        ...store.operator!,
        normalizedIdentity: "other@example.test",
      };
    if (kind === "wrong-source")
      store.operator = {
        ...store.operator!,
        sourceInvitationId: "other-invitation",
      };
    if (kind === "wrong-accepted-operator")
      store.invitation = {
        ...store.invitation,
        acceptedOperatorId: "other-operator",
      };
    if (kind === "missing-proof")
      store.invitation = { ...store.invitation, recipientProofAt: null };
    if (kind === "unaccepted")
      store.invitation = {
        ...store.invitation,
        acceptedAt: null,
        acceptedOperatorId: null,
      };
    if (kind === "late-acceptance")
      store.invitation = {
        ...store.invitation,
        expiresAt: new Date(at.getTime() - 1),
      };
    await expect(runEnrolled(store)).rejects.toMatchObject({
      code: "bootstrap_invitation_rejected",
    });
    expect(store.authorityWrites).toBe(0);
    expect(store.operatorWrites).toBe(0);
    expect(store.audits).toHaveLength(0);
  });

  it("rejects an existing different Moderator in enrolled mode", async () => {
    const store = enrolledStore();
    store.authority = {
      operatorId: "other-operator",
      grantedAt: at,
      source: "first_operator_bootstrap",
    };
    await expect(runEnrolled(store)).rejects.toBeInstanceOf(
      FirstModeratorAlreadyGrantedError,
    );
    expect(store.authorityWrites).toBe(0);
  });
});

function enrolledStore() {
  const store = new MemoryBootstrapStore(invitation());
  store.invitation = {
    ...store.invitation,
    acceptedAt: at,
    acceptedOperatorId: "operator-first",
  };
  store.operator = {
    id: "operator-first",
    normalizedIdentity: "first@example.test",
    sourceInvitationId: "invitation-first",
    createdAt: at,
  };
  return store;
}
function runEnrolled(store: MemoryBootstrapStore) {
  return bootstrapEnrolledOperator(
    {
      store,
      digestSecret: digest,
      digestsMatch: (left, right) => left === right,
      now: () => new Date(at),
    },
    {
      invitationId: "invitation-first",
      operatorId: "operator-first",
      sessionToken: "session-first.local-session-secret",
      origin: "https://operator.test",
      correlationId: "bootstrap-enrolled",
    },
  );
}

function run(
  store: FirstOperatorBootstrapStore,
  override: Partial<{
    invitationId: string;
    operatorId: string;
    now: Date;
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
      now: () => new Date(override.now ?? at),
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
  session: OperatorSessionRecord | null = {
    id: "session-first",
    operatorId: "operator-first",
    secretDigest: digest("local-session-secret"),
    origin: "https://operator.test",
    authenticatedAt: at,
    expiresAt: new Date(at.getTime() + 3600000),
    revokedAt: null,
  };
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
      readSession: async (id) =>
        this.session?.id === id ? this.session : null,
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
