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
import { createJsonOperationalLogger } from "@nobody-asked/observability";

import { createFirestoreApi } from "./composition.js";
import { deriveAgentRegistrationId } from "./registration-identifiers.js";
import { readHostedApiConfig } from "./runtime-config.js";
import { createResendOperatorChallengeDelivery } from "./resend-delivery.js";

const config = readHostedApiConfig();
const firebase = initializeApp({
  projectId: config.projectId,
  credential: applicationDefault(),
});
const api = createFirestoreApi({
  firestore: getFirestore(firebase, config.databaseId),
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
  deliverOperatorChallenge: createResendOperatorChallengeDelivery({
    apiKey: config.resendApiKey,
    fromEmail: config.operatorChallengeFromEmail,
  }),
  now: () => new Date(),
  operationalLogger: createJsonOperationalLogger((line) => console.log(line)),
  monotonicNow: () => performance.now(),
});

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
  const chunks: Buffer[] = [];
  for await (const chunk of incoming)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  const request = new Request(
    `http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`,
    {
      method: incoming.method ?? "GET",
      headers: incoming.headers as HeadersInit,
      ...(body.length === 0 ? {} : { body }),
    },
  );
  const result = await api(request);
  outgoing.writeHead(result.status, Object.fromEntries(result.headers));
  outgoing.end(Buffer.from(await result.arrayBuffer()));
}

async function stop(): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await deleteApp(firebase);
}
