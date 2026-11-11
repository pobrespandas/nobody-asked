import { createFirestoreApiAdapters } from "@nobody-asked/persistence";
import type { Firestore } from "firebase-admin/firestore";

import { createApi } from "./server.js";
import type { ApiDependencies } from "./types.js";

type FirestoreAdapterInput = Parameters<typeof createFirestoreApiAdapters>[0];

export interface FirestoreApiDependencies extends FirestoreAdapterInput {
  readonly nextCorrelationId: ApiDependencies["nextCorrelationId"];
  readonly now: ApiDependencies["now"];
  readonly operationalLogger: ApiDependencies["operationalLogger"];
  readonly monotonicNow: ApiDependencies["monotonicNow"];
  readonly nextCredentialId: ApiDependencies["nextCredentialId"];
  readonly generateCredentialSecret: ApiDependencies["generateCredentialSecret"];
  readonly deriveAgentRegistrationId: ApiDependencies["deriveAgentRegistrationId"];
  readonly generateAgentRegistrationChallenge: ApiDependencies["generateAgentRegistrationChallenge"];
  readonly deriveAgentRecoveryChallengeId?: ApiDependencies["deriveAgentRecoveryChallengeId"];
  readonly generateAgentRecoveryChallenge?: ApiDependencies["generateAgentRecoveryChallenge"];
  readonly nextOperatorId: ApiDependencies["nextOperatorId"];
  readonly nextOperatorSessionId: ApiDependencies["nextOperatorSessionId"];
  readonly generateOperatorSessionSecret: ApiDependencies["generateOperatorSessionSecret"];
  readonly nextOperatorInvitationId: ApiDependencies["nextOperatorInvitationId"];
  readonly generateOperatorInvitationSecret: ApiDependencies["generateOperatorInvitationSecret"];
  readonly nextOperatorChallengeId: ApiDependencies["nextOperatorChallengeId"];
  readonly generateOperatorChallengeSecret: ApiDependencies["generateOperatorChallengeSecret"];
  readonly deliverOperatorChallenge: ApiDependencies["deliverOperatorChallenge"];
}

export function createFirestoreApi(dependencies: FirestoreApiDependencies) {
  const adapters = createFirestoreApiAdapters(dependencies);
  return createApi({
    authenticator: adapters.authenticator,
    operatorAuthenticator: adapters.operatorAuthenticator,
    store: adapters.store,
    nextCredentialId: dependencies.nextCredentialId,
    generateCredentialSecret: dependencies.generateCredentialSecret,
    deriveAgentRegistrationId: dependencies.deriveAgentRegistrationId,
    generateAgentRegistrationChallenge:
      dependencies.generateAgentRegistrationChallenge,
    deriveAgentRecoveryChallengeId:
      dependencies.deriveAgentRecoveryChallengeId ??
      ((agentId, idempotencyKey) =>
        createHash("sha256")
          .update(`agent-recovery:${agentId}:${idempotencyKey}`)
          .digest("hex")
          .slice(0, 32)),
    generateAgentRecoveryChallenge:
      dependencies.generateAgentRecoveryChallenge ??
      (() => randomBytes(32).toString("base64url")),
    nextOperatorId: dependencies.nextOperatorId,
    nextOperatorSessionId: dependencies.nextOperatorSessionId,
    generateOperatorSessionSecret: dependencies.generateOperatorSessionSecret,
    nextOperatorInvitationId: dependencies.nextOperatorInvitationId,
    generateOperatorInvitationSecret:
      dependencies.generateOperatorInvitationSecret,
    nextOperatorChallengeId: dependencies.nextOperatorChallengeId,
    generateOperatorChallengeSecret:
      dependencies.generateOperatorChallengeSecret,
    deliverOperatorChallenge: dependencies.deliverOperatorChallenge,
    digestCredentialSecret: dependencies.digestCredentialSecret,
    nextCorrelationId: dependencies.nextCorrelationId,
    now: dependencies.now,
    readiness: createFirestoreReadiness(dependencies.firestore),
    operationalLogger: dependencies.operationalLogger,
    monotonicNow: dependencies.monotonicNow,
  });
}

export function createFirestoreReadiness(firestore: Firestore) {
  return Object.freeze({
    async check(): Promise<void> {
      await firestore.collection("_operations").doc("readiness").get();
      const recovery = await firestore
        .collection("_operations")
        .doc("deletionRecovery")
        .get();
      if (recovery.exists && recovery.data()?.ready !== true)
        throw new Error("Deletion recovery is incomplete.");
    },
  });
}
import { createHash, randomBytes } from "node:crypto";
