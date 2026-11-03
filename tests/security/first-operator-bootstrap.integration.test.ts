import { createHash, timingSafeEqual } from "node:crypto";

import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  bootstrapFirstOperator,
  bootstrapEnrolledOperator,
} from "@nobody-asked/access";
import {
  createLocalFirestoreAdmin,
  resetLocalFirestore,
  type LocalFirestoreAdmin,
} from "@nobody-asked/firestore-support";

import { createFirestoreBootstrapStore } from "../../tools/bootstrap-first-operator.js";

describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "first operator bootstrap Firestore transaction",
  () => {
    const at = new Date("2026-11-02T01:00:00.000Z");
    const secret = "emulator-invitation-secret";
    let local: LocalFirestoreAdmin;

    beforeAll(() => {
      local = createLocalFirestoreAdmin({
        appName: "first-operator-bootstrap-tests",
      });
    });
    beforeEach(async () => {
      await resetLocalFirestore();
      await local.firestore
        .collection("operatorInvitations")
        .doc("invitation-first")
        .create({
          intendedIdentity: "first@example.test",
          secretDigest: digest(secret),
          expiresAt: Timestamp.fromDate(new Date("2026-11-03T01:00:00.000Z")),
          recipientProofAt: Timestamp.fromDate(
            new Date("2026-11-02T00:59:00.000Z"),
          ),
          acceptedAt: null,
          acceptedOperatorId: null,
          revokedAt: null,
        });
    });
    afterAll(async () => deleteApp(local.app));

    it("commits one private authority and two audits, then replays", async () => {
      const input = {
        invitationId: "invitation-first",
        invitationSecret: secret,
        operatorId: "operator-first",
        correlationId: "bootstrap-first",
      };
      const dependencies = {
        store: createFirestoreBootstrapStore(local.firestore),
        digestSecret: digest,
        digestsMatch,
        now: () => new Date(at),
      };

      const results = await Promise.all([
        bootstrapFirstOperator(dependencies, input),
        bootstrapFirstOperator(dependencies, input),
      ]);
      const [operators, authorities, audits, controls, invitations] =
        await Promise.all([
          local.firestore.collection("operators").get(),
          local.firestore.collection("moderatorAuthorities").get(),
          local.firestore.collection("auditRecords").get(),
          local.firestore.collection("bootstrapControls").get(),
          local.firestore.collection("operatorInvitations").get(),
        ]);

      expect(results.map((result) => result.changed).sort()).toEqual([
        false,
        true,
      ]);
      expect([
        operators.size,
        authorities.size,
        audits.size,
        controls.size,
      ]).toEqual([1, 1, 2, 1]);
      const stored = JSON.stringify({
        invitation: invitations.docs[0]?.data(),
        operator: operators.docs[0]?.data(),
        authority: authorities.docs[0]?.data(),
        audits: audits.docs.map((document) => document.data()),
      });
      expect(stored).not.toContain(secret);
      expect(invitations.docs[0]?.data().secretDigest).toBe(digest(secret));
    }, 30_000);

    it("grants once to an enrolled Operator under contention and rechecks the session on replay", async () => {
      await local.firestore
        .collection("operatorInvitations")
        .doc("invitation-first")
        .update({
          acceptedAt: Timestamp.fromDate(at),
          acceptedOperatorId: "operator-first",
        });
      await local.firestore
        .collection("operators")
        .doc("operator-first")
        .create({
          normalizedIdentity: "first@example.test",
          sourceInvitationId: "invitation-first",
          createdAt: Timestamp.fromDate(at),
        });
      await local.firestore
        .collection("operatorSessions")
        .doc("session-first")
        .create({
          operatorId: "operator-first",
          origin: "https://operator.test",
          secretDigest: digest("session-secret"),
          authenticatedAt: Timestamp.fromDate(at),
          expiresAt: Timestamp.fromDate(new Date(at.getTime() + 3600000)),
          revokedAt: null,
        });
      const dependencies = {
        store: createFirestoreBootstrapStore(local.firestore),
        digestSecret: digest,
        digestsMatch,
        now: () => new Date(at),
      };
      const input = {
        invitationId: "invitation-first",
        operatorId: "operator-first",
        sessionToken: "session-first.session-secret",
        origin: "https://operator.test",
        correlationId: "enrolled-first",
      };
      const results = await Promise.all([
        bootstrapEnrolledOperator(dependencies, input),
        bootstrapEnrolledOperator(dependencies, input),
      ]);
      expect(results.map((result) => result.changed).sort()).toEqual([
        false,
        true,
      ]);
      expect((await local.firestore.collection("operators").get()).size).toBe(
        1,
      );
      expect(
        (await local.firestore.collection("moderatorAuthorities").get()).size,
      ).toBe(1);
      const audits = await local.firestore.collection("auditRecords").get();
      expect(audits.docs.map((doc) => doc.data().action)).toEqual([
        "moderator.authority_granted",
      ]);
      expect(
        JSON.stringify(audits.docs.map((doc) => doc.data())),
      ).not.toContain("session-secret");
      await local.firestore
        .collection("operatorSessions")
        .doc("session-first")
        .update({ revokedAt: Timestamp.fromDate(at) });
      await expect(
        bootstrapEnrolledOperator(dependencies, input),
      ).rejects.toMatchObject({ code: "bootstrap_invitation_rejected" });
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(1);
    }, 30_000);
  },
);

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestsMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
