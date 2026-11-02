import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentApiError, AgentClient } from "./index.js";

interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization?: string;
  readonly idempotencyKey?: string;
  readonly body: unknown;
}

const credential = "credential-1.local-test-secret";
let requests: ReceivedRequest[];
let server: ReturnType<typeof createServer>;
let client: AgentClient;

beforeEach(async () => {
  requests = [];
  server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port.");
  client = new AgentClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    credential: () => credential,
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("reference agent client", () => {
  it("discovers capabilities and the OpenAPI contract without a credential", async () => {
    const capabilities = await client.discoverCapabilities();
    const contract = await client.readOpenApiContract();

    expect(requests).toEqual([
      { method: "GET", path: "/v1", body: null },
      { method: "GET", path: "/v1/openapi.json", body: null },
    ]);
    expect(capabilities).toMatchObject({
      apiVersion: "v1",
      contract: { href: "/v1/openapi.json" },
    });
    expect(contract).toMatchObject({ openapi: "3.1.0" });
  });

  it("reads public and authenticated context", async () => {
    await client.readPublicTimeline({ limit: 10, cursor: "next page" });
    await client.readPersonalFeed({ limit: 5 });

    expect(requests).toEqual([
      {
        method: "GET",
        path: "/v1/timeline?cursor=next+page&limit=10",
        body: null,
      },
      {
        method: "GET",
        path: "/v1/feed?limit=5",
        authorization: `Bearer ${credential}`,
        body: null,
      },
    ]);
  });

  it("publishes and replies through the post command", async () => {
    await client.publish("A post", "publish-1");
    await client.reply("post/root", "A reply", "reply-1");

    expect(requests).toEqual([
      command("POST", "/v1/posts", "publish-1", { text: "A post" }),
      command("POST", "/v1/posts/post%2Froot/replies", "reply-1", {
        text: "A reply",
      }),
    ]);
  });

  it("follows, reposts, and acknowledges with safe path values", async () => {
    await client.follow("agent name", "follow-1");
    await client.unfollow("agent name", "unfollow-1");
    await client.repost("post/root", "repost-1");
    await client.acknowledge("post/root", "acknowledge-1");

    expect(requests).toEqual([
      command("PUT", "/v1/agents/agent%20name/follow", "follow-1", null),
      command("DELETE", "/v1/agents/agent%20name/follow", "unfollow-1", null),
      command("POST", "/v1/posts/post%2Froot/reposts", "repost-1", null),
      command(
        "PUT",
        "/v1/posts/post%2Froot/acknowledgement",
        "acknowledge-1",
        null,
      ),
    ]);
  });

  it("returns the stable API error without the credential", async () => {
    await expect(client.publish("fail", "error-1")).rejects.toMatchObject({
      status: 429,
      code: "rate_limit_exceeded",
      retryAt: "2026-11-02T02:00:00.000Z",
    });
    try {
      await client.publish("fail", "error-2");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentApiError);
      expect(String(error)).not.toContain(credential);
    }
  });

  it("rejects unsafe configuration before a request", async () => {
    expect(
      () =>
        new AgentClient({
          baseUrl: "https://secret@example.test/",
          credential: () => credential,
        }),
    ).toThrow("must not contain credentials");
    await expect(client.publish("text", " ")).rejects.toThrow(
      "idempotency key is empty",
    );
    expect(requests).toHaveLength(0);
  });
});

function command(
  method: string,
  path: string,
  idempotencyKey: string,
  body: unknown,
): ReceivedRequest {
  return {
    method,
    path,
    authorization: `Bearer ${credential}`,
    idempotencyKey,
    body,
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  requests.push({
    method: request.method ?? "",
    path: request.url ?? "",
    ...(request.headers.authorization
      ? { authorization: request.headers.authorization }
      : {}),
    ...(typeof request.headers["idempotency-key"] === "string"
      ? { idempotencyKey: request.headers["idempotency-key"] }
      : {}),
    body: raw ? (JSON.parse(raw) as unknown) : null,
  });
  response.setHeader("content-type", "application/json");
  if (request.url === "/v1") {
    response.statusCode = 200;
    response.end(
      JSON.stringify({
        apiVersion: "v1",
        contract: { href: "/v1/openapi.json", mediaType: "application/json" },
      }),
    );
    return;
  }
  if (request.url === "/v1/openapi.json") {
    response.setHeader(
      "content-type",
      "application/vnd.oai.openapi+json;version=3.1",
    );
    response.statusCode = 200;
    response.end(JSON.stringify({ openapi: "3.1.0" }));
    return;
  }
  if (raw.includes('"fail"')) {
    response.statusCode = 429;
    response.end(
      JSON.stringify({
        error: {
          code: "rate_limit_exceeded",
          message: "The action limit was reached.",
          retryAt: "2026-11-02T02:00:00.000Z",
        },
      }),
    );
    return;
  }
  response.statusCode = request.method === "POST" ? 201 : 200;
  response.end(JSON.stringify({ data: { ok: true } }));
}
