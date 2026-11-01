import { accessModule } from "@nobody-asked/access";
import { auditExportModule } from "@nobody-asked/audit-export";
import { feedsModule } from "@nobody-asked/feeds";
import { identityModule } from "@nobody-asked/identity";
import { publishingModule } from "@nobody-asked/publishing";
import { safetyModule } from "@nobody-asked/safety";
import { socialGraphModule } from "@nobody-asked/social-graph";

export const apiModules = [
  accessModule,
  identityModule,
  publishingModule,
  socialGraphModule,
  feedsModule,
  safetyModule,
  auditExportModule,
] as const;

export { createApi } from "./server.js";
export { createFirestoreApi } from "./composition.js";
export type { FirestoreApiDependencies } from "./composition.js";
export type {
  AgentCredentialAuthenticator,
  ApiDependencies,
  ApiStore,
  ApiTransaction,
  AuthenticatedAgent,
  IdempotencyRecord,
  PublicAgentProfile,
  PublicPost,
  SafetyPolicy,
} from "./types.js";
