import { createHash, randomBytes, randomUUID } from "node:crypto";
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import {
  createLocalFirestoreAdmin,
  resetLocalFirestore,
} from "@nobody-asked/firestore-support";
import { describe, expect, it, vi } from "vitest";
import { createFirestoreApi } from "../../api/src/composition.js";
import { deriveAgentRegistrationId } from "../../api/src/registration-identifiers.js";
import {
  verifyHostedModerator,
  verifyModeratorAuditEvidence,
} from "./hosted-moderator-verification.js";

describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "Moderator operational HTTP verifier with local persistence",
  () => {
    it("hides owned content, suspends only its synthetic Subject, and reads matching audit evidence", async () => {
      const local = createLocalFirestoreAdmin({
        appName: `moderator-verifier-${process.pid}`,
      });
      const originalFetch = globalThis.fetch;
      const traffic: Array<{ path: string; status: number; code?: unknown }> =
        [];
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      try {
        await resetLocalFirestore();
        const now = new Date();
        const operatorId = "synthetic-moderator";
        const secret = "synthetic-session-secret";
        await local.firestore
          .collection("operators")
          .doc(operatorId)
          .set({
            normalizedIdentity: "synthetic-moderator@example.test",
            createdAt: Timestamp.fromDate(now),
          });
        await local.firestore
          .collection("moderatorAuthorities")
          .doc(operatorId)
          .set({
            source: "local_synthetic_fixture",
            grantedAt: Timestamp.fromDate(now),
          });
        await local.firestore
          .collection("operatorSessions")
          .doc("synthetic-session")
          .set({
            operatorId,
            secretDigest: digest(secret),
            origin: "https://operator.test",
            authenticatedAt: Timestamp.fromDate(now),
            expiresAt: Timestamp.fromMillis(now.getTime() + 3_600_000),
            revokedAt: null,
          });
        const api = createFirestoreApi({
          firestore: local.firestore,
          digestCredentialSecret: digest,
          safetyPolicy: { async authorizeAgentWrite() {} },
          nextCorrelationId: randomUUID,
          nextCredentialId: randomUUID,
          generateCredentialSecret: () => randomBytes(32).toString("base64url"),
          deriveAgentRegistrationId,
          generateAgentRegistrationChallenge: () =>
            randomBytes(32).toString("base64url"),
          nextOperatorId: randomUUID,
          nextOperatorSessionId: randomUUID,
          generateOperatorSessionSecret: () =>
            randomBytes(32).toString("base64url"),
          nextOperatorInvitationId: randomUUID,
          generateOperatorInvitationSecret: () =>
            randomBytes(32).toString("base64url"),
          nextOperatorChallengeId: randomUUID,
          generateOperatorChallengeSecret: () =>
            randomBytes(32).toString("base64url"),
          deliverOperatorChallenge: async () => {
            throw new Error("No email in local moderation verification.");
          },
          now: () => new Date(),
          operationalLogger: { write() {} },
          monotonicNow: () => performance.now(),
        });
        vi.stubGlobal(
          "fetch",
          async (input: RequestInfo | URL, options?: RequestInit) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.origin === "https://network.test") {
              const response = await api(new Request(input, options));
              const body = (await response.clone().json()) as {
                error?: { code?: string };
              };
              traffic.push({
                path: url.pathname,
                status: response.status,
                ...(body.error?.code ? { code: body.error.code } : {}),
              });
              return response;
            }
            if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
              return originalFetch(input, options);
            throw new Error(
              "Remote HTTP is disabled in the local verifier test.",
            );
          },
        );
        const report = await verifyHostedModerator({
          baseUrl: new URL("https://network.test/"),
          operatorId,
          operatorCookie: `__session=synthetic-session.${secret}`,
          origin: "https://operator.test",
        });
        expect(
          report.result,
          `Moderator verifier failed at ${report.phase}: ${JSON.stringify(traffic.slice(-12))}`,
        ).toBe("pass");
        expect(report.cleanup).toMatchObject({
          reporter: "stopped",
          subject: "suspended_credentials_revoked",
          post: "retained_hidden",
        });
        const audit = await verifyModeratorAuditEvidence({
          operatorId,
          report,
          readSubjectAudits: async (id) =>
            (
              await local.firestore
                .collection("auditRecords")
                .where("subjectId", "==", id)
                .get()
            ).docs.map((doc) => doc.data()),
        });
        expect(audit).toMatchObject({ result: "pass", verifiedRecords: 4 });
        const subject = await local.firestore
          .collection("agentProfiles")
          .doc(report.subjectId!)
          .get();
        expect(subject.data()?.status).toBe("suspended");
        expect(subject.data()).not.toHaveProperty("controllingOperatorId");
        expect(
          (
            await local.firestore
              .collection("credentials")
              .where("agentId", "==", report.subjectId)
              .get()
          ).docs.every((doc) => doc.data().revokedAt !== null),
        ).toBe(true);
        expect(JSON.stringify({ report, audit })).not.toContain(secret);
        expect(JSON.stringify({ report, audit })).not.toContain(operatorId);
      } finally {
        vi.unstubAllGlobals();
        await resetLocalFirestore();
        await deleteApp(local.app);
      }
    }, 120_000);
  },
);
