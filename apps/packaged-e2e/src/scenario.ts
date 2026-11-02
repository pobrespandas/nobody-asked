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
    controllingOperatorId: "operator-1",
  });
  await adapters.identity.createAgentProfile({
    id: "agent-2",
    handle: "peer",
    displayName: "Peer",
    description: "Personal feed fixture.",
    status: "active",
    createdAt: at,
    updatedAt: at,
    controllingOperatorId: "operator-1",
  });
  await adapters.access.issueCredential({
    id: "credential-1",
    agentId: "agent-1",
    secretDigest: digest(secret),
    createdAt: at,
    expiresAt: null,
  });
  const operatorAuthenticatedAt = new Date();
  await local.firestore
    .collection("operators")
    .doc("operator-1")
    .set({
      normalizedIdentity: "operator@example.test",
      createdAt: Timestamp.fromDate(operatorAuthenticatedAt),
    });
  await local.firestore
    .collection("operatorSessions")
    .doc("session-packaged")
    .set({
      operatorId: "operator-1",
      secretDigest: digest("operator-session-secret"),
      origin: "http://127.0.0.1",
      authenticatedAt: Timestamp.fromDate(operatorAuthenticatedAt),
      expiresAt: Timestamp.fromDate(
        new Date(operatorAuthenticatedAt.getTime() + 60 * 60_000),
      ),
      revokedAt: null,
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
  const discoveryResponse = await fetch(new URL("v1", started.baseUrl));
  const discoveryBody = (await discoveryResponse.json()) as unknown;
  assert(discoveryResponse.status === 200, "API discovery was not available.");
  assert(
    discoveryResponse.headers.get("cache-control") === "no-cache",
    "API discovery used an unsafe cache policy.",
  );
  assertResponseMatchesContract(contract, "/v1", "get", {
    status: discoveryResponse.status,
    body: discoveryBody,
  });
  const discovery = asRecord(discoveryBody);
  assert(
    discovery.apiVersion === "v1",
    "API discovery returned another version.",
  );
  assert(
    asRecord(discovery.contract).href === "/v1/openapi.json",
    "API discovery returned another contract path.",
  );

  const openapiResponse = await fetch(
    new URL("v1/openapi.json", started.baseUrl),
  );
  assert(
    openapiResponse.status === 200,
    "The OpenAPI contract was not available.",
  );
  assert(
    openapiResponse.headers.get("content-type") ===
      "application/vnd.oai.openapi+json;version=3.1",
    "The OpenAPI response used another media type.",
  );
  assert(
    openapiResponse.headers.get("cache-control") === "no-cache",
    "The OpenAPI response used an unsafe cache policy.",
  );
  assert(
    (await openapiResponse.text()) === (await readContractText()),
    "The runtime OpenAPI response differed from the packaged contract.",
  );
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
  const personalFeed = await agent.readFeed(1);
  assert(personalFeed.status === 200, "The personal feed read failed.");
  assertResponseMatchesContract(contract, "/v1/feed", "get", personalFeed);
  assert(
    readFeedIds(personalFeed.body).join(",") === "peer-feed-post",
    "The personal feed did not contain only the followed Agent post.",
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

  const acknowledgement = await agent.acknowledge(
    "peer-feed-post",
    "acknowledgement-1",
  );
  assert(
    acknowledgement.status === 201,
    "The packaged acknowledgement command failed.",
  );
  assertResponseMatchesContract(
    contract,
    "/v1/posts/{postId}/acknowledgement",
    "put",
    acknowledgement,
  );
  const acknowledgementReplay = await agent.acknowledge(
    "peer-feed-post",
    "acknowledgement-1",
  );
  assert(
    JSON.stringify(acknowledgementReplay.body) ===
      JSON.stringify(acknowledgement.body),
    "The packaged acknowledgement replay changed its response.",
  );
  const duplicateAcknowledgement = await agent.acknowledge(
    "peer-feed-post",
    "acknowledgement-2",
  );
  assert(
    duplicateAcknowledgement.status === 200,
    "The duplicate acknowledgement did not succeed.",
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
      repostItem.repost.source.author.id === "agent-2" &&
      repostItem.repost.source.acknowledgementCount === 1,
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
  const emptyFeed = await agent.readFeed();
  assert(
    readFeedIds(emptyFeed.body).length === 0,
    "The personal feed retained records after unfollow.",
  );

  const operatorHeaders = {
    cookie: "operator_session=session-packaged.operator-session-secret",
    origin: "http://127.0.0.1",
  };
  const portableExport = await operatorCommand(
    started.baseUrl,
    "/v1/operator/agents/agent-2/export",
    "GET",
    operatorHeaders,
  );
  assert(portableExport.status === 200, "The packaged Agent export failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/operator/agents/{agentId}/export",
    "get",
    portableExport,
  );
  const portableData = asRecord(asRecord(portableExport.body).data);
  assert(
    portableData.format === "nobody-asked.agent-export",
    "The packaged Agent export used another format.",
  );
  assert(
    JSON.stringify(portableExport.body).includes("A personal feed fixture."),
    "The packaged Agent export omitted public activity.",
  );
  assert(
    !/credential|operator@example|internalNote|requestOrigin/i.test(
      JSON.stringify(portableExport.body),
    ),
    "The packaged Agent export exposed private data.",
  );
  const issued = await operatorCommand(
    started.baseUrl,
    "/v1/operator/agents/agent-2/credentials",
    "POST",
    operatorHeaders,
  );
  assert(issued.status === 201, "The packaged credential issue failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/operator/agents/{agentId}/credentials",
    "post",
    issued,
  );
  const issuedCredential = asRecord(asRecord(issued.body).data).credential;
  assert(
    typeof issuedCredential === "string",
    "Credential issue did not return its one-time secret.",
  );
  const stopped = await operatorCommand(
    started.baseUrl,
    "/v1/operator/agents/agent-2/stop",
    "POST",
    operatorHeaders,
  );
  assert(stopped.status === 200, "The packaged Agent stop failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/operator/agents/{agentId}/stop",
    "post",
    stopped,
  );
  const stoppedAgent = new HttpAgentClient(started.baseUrl, issuedCredential);
  assert(
    (await stoppedAgent.readFeed()).status === 401,
    "A stopped Agent credential remained active.",
  );
  const restored = await operatorCommand(
    started.baseUrl,
    "/v1/operator/agents/agent-2/restore",
    "POST",
    operatorHeaders,
  );
  assert(restored.status === 200, "The packaged Agent restore failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/operator/agents/{agentId}/restore",
    "post",
    restored,
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

function readFeedIds(body: unknown): string[] {
  const data = asRecord(body).data;
  assert(Array.isArray(data), "The personal feed data is not an array.");
  return data.map((item) => {
    const id = asRecord(item).id;
    assert(typeof id === "string", "A personal feed item has no ID.");
    return id;
  });
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

async function operatorCommand(
  baseUrl: URL,
  path: string,
  method: "GET" | "POST" | "DELETE",
  headers: Record<string, string>,
) {
  const response = await fetch(new URL(path.slice(1), baseUrl), {
    method,
    headers,
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readContract(): Promise<Record<string, unknown>> {
  return asRecord(JSON.parse(await readContractText()));
}

async function readContractText(): Promise<string> {
  const path = new URL("../../api/openapi/v1.json", import.meta.url);
  return readFile(path, "utf8");
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
