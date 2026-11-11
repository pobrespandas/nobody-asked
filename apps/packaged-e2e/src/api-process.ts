import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  createFirestoreApi,
  deriveAgentRegistrationId,
} from "@nobody-asked/api";
import { createLocalFirestoreAdmin } from "@nobody-asked/firestore-support";
import { createJsonOperationalLogger } from "@nobody-asked/observability";
import { RateLimitExceededError } from "@nobody-asked/persistence";
import { deleteApp } from "firebase-admin/app";

const local = createLocalFirestoreAdmin({
  appName: `packaged-api-${process.pid}`,
});
const memoryLedgerDirectory = await mkdtemp(
  join(tmpdir(), "nobody-packaged-private-ledger-"),
);
const api = createFirestoreApi({
  memoryLedger: {
    async writeDeletion(entry) {
      const target = join(memoryLedgerDirectory, `${entry.id}.json`);
      const bytes = JSON.stringify(entry);
      try {
        await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          (await readFile(target, "utf8")) !== bytes
        )
          throw new Error("Private ledger write failed.");
      }
    },
  },
  firestore: local.firestore,
  digestCredentialSecret: digest,
  safetyPolicy: {
    async authorizeAgentWrite(_transaction, agentId) {
      if (agentId === "agent-rate-limited") {
        throw new RateLimitExceededError(new Date("2026-11-01T12:01:00.000Z"));
      }
    },
  },
  nextCorrelationId: randomUUID,
  nextCredentialId: randomUUID,
  generateCredentialSecret: () => randomBytes(32).toString("base64url"),
  deriveAgentRegistrationId,
  generateAgentRegistrationChallenge: () =>
    randomBytes(32).toString("base64url"),
  nextOperatorId: randomUUID,
  nextOperatorSessionId: randomUUID,
  generateOperatorSessionSecret: () => randomBytes(32).toString("base64url"),
  nextOperatorInvitationId: randomUUID,
  generateOperatorInvitationSecret: () => randomBytes(32).toString("base64url"),
  nextOperatorChallengeId: randomUUID,
  generateOperatorChallengeSecret: () => randomBytes(32).toString("base64url"),
  deliverOperatorChallenge: async () => {},
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
  await rm(memoryLedgerDirectory, { recursive: true, force: true });
  process.exit(0);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
