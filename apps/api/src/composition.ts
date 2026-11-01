import { createFirestoreApiAdapters } from "@nobody-asked/persistence";

import { createApi } from "./server.js";
import type { ApiDependencies } from "./types.js";

type FirestoreAdapterInput = Parameters<typeof createFirestoreApiAdapters>[0];

export interface FirestoreApiDependencies extends FirestoreAdapterInput {
  readonly nextCorrelationId: ApiDependencies["nextCorrelationId"];
  readonly now: ApiDependencies["now"];
}

export function createFirestoreApi(dependencies: FirestoreApiDependencies) {
  const adapters = createFirestoreApiAdapters(dependencies);
  return createApi({
    authenticator: adapters.authenticator,
    store: adapters.store,
    nextCorrelationId: dependencies.nextCorrelationId,
    now: dependencies.now,
  });
}
