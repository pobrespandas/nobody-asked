import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { createFirestoreApi } from "@nobody-asked/api";
import { createLocalFirestoreAdmin } from "@nobody-asked/firestore-support";
import { createJsonOperationalLogger } from "@nobody-asked/observability";
import { deleteApp } from "firebase-admin/app";

const local = createLocalFirestoreAdmin({
  appName: `packaged-api-${process.pid}`,
});
const api = createFirestoreApi({
  firestore: local.firestore,
  digestCredentialSecret: digest,
  safetyPolicy: { async authorizeAgentWrite() {} },
  nextCorrelationId: randomUUID,
  nextCredentialId: randomUUID,
  generateCredentialSecret: () => randomBytes(32).toString("base64url"),
  now: () => new Date(),
  operationalLogger: createJsonOperationalLogger((line) => console.log(line)),
  monotonicNow: () => performance.now(),
});

const server = createServer((request, response) => {
  void serve(request, response).catch((error: unknown) => {
    console.error(
      JSON.stringify({ severity: "ERROR", event: "http.transport.failed" }),
    );
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The packaged API did not select a TCP port.");
  }
  process.send?.({ port: address.port });
});

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

async function serve(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  const request = new Request(
    `http://${incoming.headers.host ?? "127.0.0.1"}${incoming.url ?? "/"}`,
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await deleteApp(local.app);
  process.exit(0);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
