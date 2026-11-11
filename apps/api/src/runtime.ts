import { createCloudMemoryLedger } from "./cloud-memory-ledger.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { assertRecoveryGate } from "./admin/recovery.js";
import { createHostedAdministration } from "./admin/index.js";
import { administrationLogger } from "./admin/metrics.js";
import { createPublicHtml } from "@nobody-asked/browser";
import { createJsonOperationalLogger } from "@nobody-asked/observability";

import { createFirestoreApi } from "./composition.js";
import { bindRegistrationNetworkSource } from "./request-source.js";
import { deriveAgentRegistrationId } from "./registration-identifiers.js";
import { readHostedApiConfig } from "./runtime-config.js";
import { createResendOperatorChallengeDelivery } from "./resend-delivery.js";
import { createIcloudOperatorChallengeDelivery } from "./icloud-delivery.js";

const config = readHostedApiConfig();
const firebase = initializeApp({
  projectId: config.projectId,
  credential: applicationDefault(),
});
const firestore = getFirestore(firebase, config.databaseId);
const baseLogger = createJsonOperationalLogger((line) => console.log(line));
const adminLogger =
  process.env.ADMIN_ENABLED === "true"
    ? administrationLogger(firestore, baseLogger)
    : null;
const administration = createHostedAdministration(firestore);
const recoveryReady =
  process.env.ADMIN_REQUIRE_RECOVERY_LEDGER === "true"
    ? process.env.ADMIN_RECOVERY_ID
      ? assertRecoveryGate(firestore, new Date(), process.env.ADMIN_RECOVERY_ID)
      : Promise.reject(new Error("ADMIN_RECOVERY_ID is required."))
    : Promise.resolve();
void recoveryReady.catch(() => {});
const api = createFirestoreApi({
  memoryLedger: createCloudMemoryLedger(process.env.ADMIN_LEDGER_BUCKET),
  firestore,
  digestCredentialSecret: (value) =>
    createHash("sha256").update(value).digest("hex"),
  safetyPolicy: { async authorizeAgentWrite() {} },
  nextCorrelationId: randomUUID,
  nextCredentialId: randomUUID,
  generateCredentialSecret: () => randomBytes(32).toString("base64url"),
  deriveAgentRegistrationId,
  generateAgentRegistrationChallenge: () =>
    randomBytes(32).toString("base64url"),
  deriveAgentRecoveryChallengeId: (agentId, idempotencyKey) =>
    createHash("sha256")
      .update(`agent-recovery:${agentId}:${idempotencyKey}`)
      .digest("hex")
      .slice(0, 32),
  generateAgentRecoveryChallenge: () => randomBytes(32).toString("base64url"),
  nextOperatorId: randomUUID,
  nextOperatorSessionId: randomUUID,
  generateOperatorSessionSecret: () => randomBytes(32).toString("base64url"),
  nextOperatorInvitationId: randomUUID,
  generateOperatorInvitationSecret: () => randomBytes(32).toString("base64url"),
  nextOperatorChallengeId: randomUUID,
  generateOperatorChallengeSecret: () => randomBytes(32).toString("base64url"),
  deliverOperatorChallenge:
    config.operatorMail.provider === "icloud"
      ? createIcloudOperatorChallengeDelivery(config.operatorMail)
      : createResendOperatorChallengeDelivery(config.operatorMail),
  now: () => new Date(),
  operationalLogger: adminLogger ?? baseLogger,
  monotonicNow: () => performance.now(),
});

const publicHtml = createPublicHtml(api);

const server = createServer((request, response) => {
  void serve(request, response).catch((error: unknown) => {
    void error;
    console.error('{"severity":"ERROR","event":"http.transport.failed"}');
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

server.listen(config.port, "0.0.0.0");
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

async function serve(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  try {
    await recoveryReady;
  } catch {
    outgoing.writeHead(503, { "cache-control": "no-store" });
    outgoing.end("Recovery verification is required.");
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_048_576) {
      outgoing.writeHead(413);
      outgoing.end();
      return;
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks);
  const request = new Request(
    `http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`,
    {
      method: incoming.method ?? "GET",
      headers: incoming.headers as HeadersInit,
      ...(body.length === 0 ? {} : { body }),
    },
  );
  bindRegistrationNetworkSource(request, incoming.socket.remoteAddress);
  const result =
    (await administration(request)) ??
    (await publicHtml(request)) ??
    (await api(request));
  await adminLogger?.flush();
  outgoing.writeHead(result.status, Object.fromEntries(result.headers));
  outgoing.end(
    request.method === "HEAD"
      ? undefined
      : Buffer.from(await result.arrayBuffer()),
  );
}

async function stop(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await deleteApp(firebase);
}
