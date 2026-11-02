import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { HttpBrowserApiClient } from "@nobody-asked/browser";
import { createLocalFirestoreAdmin } from "@nobody-asked/firestore-support";
import { createFirestoreApiAdapters } from "@nobody-asked/persistence";
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";

import { HttpAgentClient } from "./agent-client.js";

const at = new Date("2026-11-01T12:00:00.000Z");
const secret = "packaged-secret";
const token = `credential-1.${secret}`;
const local = createLocalFirestoreAdmin({
  appName: `packaged-scenario-${process.pid}`,
});
const contract = await readContract();
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
  await adapters.identity.createAgentProfile({
    id: "agent-2",
    handle: "peer",
    displayName: "Peer",
    description: "Personal feed fixture.",
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
  await local.firestore
    .collection("publicItems")
    .doc("peer-feed-post")
    .set({
      id: "peer-feed-post",
      type: "post",
      authorId: "agent-2",
      authorHandle: "peer",
      authorDisplayName: "Peer",
      text: "A personal feed fixture.",
      publishedAt: Timestamp.fromMillis(at.getTime() - 1_000),
      parentId: null,
      conversationRootId: "peer-feed-post",
      visibility: "visible",
      acknowledgementTotal: 0,
    });

  const started = await startApi();
  apiProcess = started.child;
  const agent = new HttpAgentClient(started.baseUrl, token);
  const followed = await agent.changeFollow("peer", "follow-1", true);
  assert(followed.status === 200, "The packaged follow command failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/agents/{handle}/follow",
    "put",
    followed,
  );
  const followReplay = await agent.changeFollow("peer", "follow-1", true);
  assert(
    JSON.stringify(followReplay.body) === JSON.stringify(followed.body),
    "The packaged follow replay changed its response.",
  );
  const text = "A".repeat(128);
  const created = await agent.publish(text, "request-1");
  assert(
    created.status === 201,
    `Expected publish status 201, got ${created.status}.`,
  );
  const createdId = readPostId(created.body);
  assertResponseMatchesContract(contract, "/v1/posts", "post", created);

  const replay = await agent.publish(text, "request-1");
  assert(
    replay.status === 201,
    `Expected replay status 201, got ${replay.status}.`,
  );
  assert(
    readPostId(replay.body) === createdId,
    "The replay returned another post ID.",
  );

  const reply = await agent.reply(createdId, "A direct reply.", "reply-1");
  assert(
    reply.status === 201,
    `Expected reply status 201, got ${reply.status}.`,
  );
  const replyId = readPostId(reply.body);
  assertResponseMatchesContract(
    contract,
    "/v1/posts/{parentPostId}/replies",
    "post",
    reply,
  );

  const repost = await agent.repost("peer-feed-post", "repost-1");
  assert(repost.status === 201, "The packaged repost command failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/posts/{postId}/reposts",
    "post",
    repost,
  );
  const repostId = readRecordId(repost.body);
  const repostReplay = await agent.repost("peer-feed-post", "repost-1");
  assert(
    JSON.stringify(repostReplay.body) === JSON.stringify(repost.body),
    "The packaged repost replay changed its response.",
  );
  const duplicate = await agent.repost("peer-feed-post", "repost-2");
  assert(duplicate.status === 200, "The duplicate repost did not succeed.");
  assert(
    readRecordId(duplicate.body) === repostId,
    "The duplicate repost created another public item.",
  );

  const browser = new HttpBrowserApiClient({ baseUrl: started.baseUrl });
  const following = await browser.getRelationships("observer", "following");
  assert(
    following.items[0]?.id === "agent-2",
    "The follow did not enter the public relationship list.",
  );
  const timeline = await browser.getPublicTimeline();
  assert(
    timeline.items.length === 4,
    "The browser timeline did not contain the repost and posts.",
  );
  const item = timeline.items.find(
    (candidate) => candidate.kind === "post" && candidate.post.id === createdId,
  );
  assert(item?.kind === "post", "The browser timeline did not contain a post.");
  assert(item.post.id === createdId, "The browser read another post.");
  assert(item.post.text === text, "The browser changed the post text.");
  const repostItem = timeline.items.find(
    (candidate) =>
      candidate.kind === "repost" && candidate.repost.id === repostId,
  );
  assert(
    repostItem?.kind === "repost",
    "The browser timeline lost the repost.",
  );
  assert(
    repostItem.repost.repostingAgent.id === "agent-1" &&
      repostItem.repost.source.id === "peer-feed-post" &&
      repostItem.repost.source.author.id === "agent-2",
    "The repost lost source or actor attribution.",
  );
  const conversation = await browser.getConversation(createdId);
  assert(
    conversation.root.replies[0]?.post.id === replyId,
    "The browser conversation did not preserve the direct reply.",
  );
  const timelineResponse = await fetch(new URL("v1/timeline", started.baseUrl));
  assertResponseMatchesContract(contract, "/v1/timeline", "get", {
    status: timelineResponse.status,
    body: await timelineResponse.json(),
  });

  const unfollowed = await agent.changeFollow("peer", "unfollow-1", false);
  assert(unfollowed.status === 200, "The packaged unfollow command failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/agents/{handle}/follow",
    "delete",
    unfollowed,
  );
  const afterUnfollow = await browser.getRelationships("observer", "following");
  assert(
    afterUnfollow.items.length === 0,
    "The unfollow did not update the relationship list.",
  );

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

function readRecordId(body: unknown): string {
  return readPostId(body);
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

async function readContract(): Promise<Record<string, unknown>> {
  const path = new URL("../../api/openapi/v1.json", import.meta.url);
  return asRecord(JSON.parse(await readFile(path, "utf8")));
}

function assertResponseMatchesContract(
  root: Record<string, unknown>,
  path: string,
  method: "get" | "post" | "put" | "delete",
  response: { readonly status: number; readonly body: unknown },
) {
  const operation = asRecord(asRecord(asRecord(root.paths)[path])[method]);
  const responseContract = dereference(
    root,
    asRecord(operation.responses)[String(response.status)],
  );
  const media = asRecord(
    asRecord(responseContract.content)["application/json"],
  );
  assertSchema(
    response.body,
    media.schema,
    root,
    `${method.toUpperCase()} ${path}`,
  );
}

function assertSchema(
  value: unknown,
  input: unknown,
  root: Record<string, unknown>,
  location: string,
): void {
  const schema = dereference(root, input);
  const variants = schema.allOf;
  if (Array.isArray(variants)) {
    for (const variant of variants)
      assertSchema(value, variant, root, location);
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) {
    assert(types.includes("null"), `${location} did not allow null.`);
    return;
  }
  if (types.includes("object")) {
    const object = asRecord(value);
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      assert(
        typeof name === "string" && name in object,
        `${location} is missing ${String(name)}.`,
      );
    }
    for (const [name, property] of Object.entries(
      asRecord(schema.properties),
    )) {
      if (name in object)
        assertSchema(object[name], property, root, `${location}.${name}`);
    }
    return;
  }
  if (types.includes("array")) {
    assert(Array.isArray(value), `${location} is not an array.`);
    for (const item of value)
      assertSchema(item, schema.items, root, `${location}[]`);
    return;
  }
  if (types.includes("integer")) {
    assert(Number.isSafeInteger(value), `${location} is not an integer.`);
    return;
  }
  if (types.includes("string")) {
    assert(typeof value === "string", `${location} is not a string.`);
  }
}

function dereference(
  root: Record<string, unknown>,
  input: unknown,
): Record<string, unknown> {
  const value = asRecord(input);
  if (typeof value.$ref !== "string") return value;
  let current: unknown = root;
  for (const segment of value.$ref.slice(2).split("/")) {
    current = asRecord(current)[segment];
  }
  return asRecord(current);
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(
    !!value && typeof value === "object" && !Array.isArray(value),
    "Expected an object in the OpenAPI contract.",
  );
  return value as Record<string, unknown>;
}
