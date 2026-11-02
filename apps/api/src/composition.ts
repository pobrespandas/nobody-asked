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
}

export function createFirestoreApi(dependencies: FirestoreApiDependencies) {
  const adapters = createFirestoreApiAdapters(dependencies);
  return createApi({
    authenticator: adapters.authenticator,
    operatorAuthenticator: adapters.operatorAuthenticator,
    store: adapters.store,
    nextCredentialId: dependencies.nextCredentialId,
    generateCredentialSecret: dependencies.generateCredentialSecret,
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
    },
  });
}
