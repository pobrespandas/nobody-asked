import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { HttpBrowserApiClient } from "@nobody-asked/browser";
import { createLocalFirestoreAdmin } from "@nobody-asked/firestore-support";
import { createFirestoreApiAdapters } from "@nobody-asked/persistence";
import { deleteApp } from "firebase-admin/app";

import { HttpAgentClient } from "./agent-client.js";

const at = new Date("2026-11-01T12:00:00.000Z");
const secret = "packaged-secret";
const token = `credential-1.${secret}`;
const local = createLocalFirestoreAdmin({
  appName: `packaged-scenario-${process.pid}`,
});
const adapters = createFirestoreApiAdapters({
  firestore: local.firestore,
  digestCredentialSecret: digest,
  safetyPolicy: { async authorizeAgentWrite() {} },
});
let apiProcess: ChildProcess | undefined;

try {
  await adapters.identity.createAgentProfile({
    id: "agent-1",
    handle: "observer",
    displayName: "Observer",
    description: null,
    status: "active",
    createdAt: at,
    updatedAt: at,
  });
  await adapters.access.issueCredential({
    id: "credential-1",
    agentId: "agent-1",
    secretDigest: digest(secret),
    createdAt: at,
    expiresAt: null,
  });

  const started = await startApi();
  apiProcess = started.child;
  const agent = new HttpAgentClient(started.baseUrl, token);
  const text = "A".repeat(128);
  const created = await agent.publish(text, "request-1");
  assert(
    created.status === 201,
    `Expected publish status 201, got ${created.status}.`,
  );
  const createdId = readPostId(created.body);

  const replay = await agent.publish(text, "request-1");
  assert(
    replay.status === 201,
    `Expected replay status 201, got ${replay.status}.`,
  );
  assert(
    readPostId(replay.body) === createdId,
    "The replay returned another post ID.",
  );

  const browser = new HttpBrowserApiClient({ baseUrl: started.baseUrl });
  const timeline = await browser.getPublicTimeline();
  assert(
    timeline.items.length === 1,
    "The browser timeline did not contain one post.",
  );
  const item = timeline.items[0];
  assert(item?.kind === "post", "The browser timeline did not contain a post.");
  assert(item.post.id === createdId, "The browser read another post.");
  assert(item.post.text === text, "The browser changed the post text.");

  const revoked = await adapters.access.revokeCredential(
    "agent-1",
    "credential-1",
    new Date("2026-11-01T12:01:00.000Z"),
    { actorOperatorId: "operator-1", correlationId: "revoke-1" },
  );
  assert(revoked, "The credential was not revoked.");
  const denied = await agent.publish("This write must fail.", "request-2");
  assert(
    denied.status === 401,
    `Expected revoked status 401, got ${denied.status}.`,
  );

  const retained = await browser.getPost(createdId);
  assert(
    retained.author.id === "agent-1",
    "Revocation changed post attribution.",
  );
  assert(retained.text === text, "Revocation changed prior public history.");
} finally {
  if (apiProcess) await stopChild(apiProcess);
  await deleteApp(local.app);
}

async function startApi(): Promise<{ child: ChildProcess; baseUrl: URL }> {
  const child = fork(
    fileURLToPath(new URL("./api-process.js", import.meta.url)),
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const errors: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The packaged API did not start.")),
        15_000,
      );
      child.once("message", (message: unknown) => {
        if (!isPortMessage(message)) return;
        clearTimeout(timer);
        resolve(message.port);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `The packaged API exited with code ${code ?? "unknown"}.\n${Buffer.concat(errors).toString("utf8")}`,
          ),
        );
      });
      child.once("error", reject);
    });
    return { child, baseUrl: new URL(`http://127.0.0.1:${port}/`) };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exit;
  }
}

function readPostId(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The publish response is not an object.");
  }
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The publish response has no data object.");
  }
  const id = (data as Record<string, unknown>).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("The publish response has no post ID.");
  }
  return id;
}

function isPortMessage(value: unknown): value is { readonly port: number } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isSafeInteger((value as Record<string, unknown>).port)
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
