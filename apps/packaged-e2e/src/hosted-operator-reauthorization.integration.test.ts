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
import { verifyHostedOperatorReauthorization } from "./hosted-operator-reauthorization.js";
describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "Distinct Operator reauthorization with local persistence",
  () => {
    it("replaces removed authority only through a new grant and keeps old acceptance replay inert", async () => {
      const local = createLocalFirestoreAdmin({
        appName: `reauthorization-${process.pid}`,
      });
      const originalFetch = globalThis.fetch;
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const traffic: Array<{ path: string; status: number; code?: string }> =
        [];
      const now = new Date();
      const main = {
        operatorId: "synthetic-main",
        operatorCookie: "__session=main-session.main-secret",
      };
      const peer = {
        operatorId: "synthetic-peer",
        operatorCookie: "__session=peer-session.peer-secret",
      };
      try {
        await resetLocalFirestore();
        for (const [context, identity, sessionId, secret] of [
          [main, "main@example.test", "main-session", "main-secret"],
          [peer, "peer@example.test", "peer-session", "peer-secret"],
        ] as const) {
          await local.firestore
            .collection("operators")
            .doc(context.operatorId)
            .set({
              normalizedIdentity: identity,
              createdAt: Timestamp.fromDate(now),
            });
          await local.firestore
            .collection("operatorSessions")
            .doc(sessionId)
            .set({
              operatorId: context.operatorId,
              secretDigest: digest(secret),
              origin: "https://operator.test",
              authenticatedAt: Timestamp.fromDate(now),
              expiresAt: Timestamp.fromMillis(now.getTime() + 3_600_000),
              revokedAt: null,
            });
        }
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
            throw new Error("No local email.");
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
            throw new Error("Remote HTTP is disabled in local verification.");
          },
        );
        const report = await verifyHostedOperatorReauthorization({
          baseUrl: new URL("https://network.test/"),
          origin: "https://operator.test",
          mainOperator: main,
          peerOperator: peer,
        });
        expect(
          report.result,
          `Reauthorization failed at ${report.phase}: ${JSON.stringify(traffic.slice(-12))}`,
        ).toBe("pass");
        expect(report.cleanup).toBe("stopped");
        expect(report.checks).toContain("old_acceptance_replay");
        const profile = await local.firestore
          .collection("agentProfiles")
          .doc(report.agentId!)
          .get();
        expect(profile.data()?.status).toBe("stopped");
        expect(profile.data()).not.toHaveProperty("controllingOperatorId");
        const authority = await local.firestore
          .collection("agentOperatorAuthority")
          .doc(report.agentId!)
          .get();
        expect(authority.data()?.operatorId).toBeNull();
        expect(JSON.stringify(report)).not.toMatch(
          /main-secret|peer-secret|synthetic-main|synthetic-peer/,
        );
      } finally {
        vi.unstubAllGlobals();
        await resetLocalFirestore();
        await deleteApp(local.app);
      }
    }, 120_000);
  },
);
