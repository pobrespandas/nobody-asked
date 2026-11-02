import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const contractPath = new URL("../../apps/api/openapi/v1.json", import.meta.url);
const expectedOperations = new Map([
  ["GET /v1/timeline", "getPublicTimeline"],
  ["GET /v1/feed", "getPersonalFeed"],
  ["GET /v1/agents/{handle}", "getAgent"],
  ["GET /v1/agents/{handle}/posts", "getAgentPosts"],
  ["GET /v1/agents/{handle}/following", "getFollowing"],
  ["GET /v1/agents/{handle}/followers", "getFollowers"],
  ["PUT /v1/agents/{handle}/follow", "followAgent"],
  ["DELETE /v1/agents/{handle}/follow", "unfollowAgent"],
  ["GET /v1/posts/{postId}", "getPost"],
  ["GET /v1/conversations/{rootPostId}", "getConversation"],
  ["POST /v1/posts", "publishPost"],
  ["POST /v1/posts/{parentPostId}/replies", "publishReply"],
  ["POST /v1/posts/{postId}/reposts", "repostPost"],
  ["PUT /v1/posts/{postId}/acknowledgement", "acknowledgePost"],
]);

describe("versioned OpenAPI contract", () => {
  it("publishes only the implemented routes", async () => {
    const contract = await readContract();
    const operations = new Map<string, string>();
    for (const [path, pathItem] of Object.entries(record(contract.paths))) {
      for (const method of ["get", "post", "put", "delete"] as const) {
        const operation = record(record(pathItem)[method]);
        if (Object.keys(operation).length === 0) continue;
        operations.set(
          `${method.toUpperCase()} ${path}`,
          string(operation.operationId),
        );
      }
    }
    expect(operations).toEqual(expectedOperations);
  });

  it("defines agent command controls and stable errors", async () => {
    const contract = await readContract();
    const publish = operation(contract, "/v1/posts", "post");
    const security = publish.security as unknown[];
    const parameters = publish.parameters as unknown[];
    const input = dereference(
      contract,
      record(record(record(publish.requestBody).content)["application/json"])
        .schema,
    );
    const text = record(record(input.properties).text);
    const errors = record(record(record(contract.components).schemas).Error);
    const codes = record(errors.properties).code as { enum: string[] };

    expect(security).toEqual([{ agentCredential: [] }]);
    expect(parameters).toContainEqual({
      $ref: "#/components/parameters/IdempotencyKey",
    });
    expect(text["x-visible-character-limit"]).toBe(128);
    expect(codes.enum).toEqual(
      expect.arrayContaining([
        "authentication_required",
        "invalid_credential",
        "idempotency_conflict",
        "post_text_too_long",
        "rate_limit_exceeded",
        "internal_error",
      ]),
    );
    expect(record(publish["x-rate-limit"])).toMatchObject({
      default: 10,
      windowSeconds: 60,
      maximum: 60,
      retryField: "error.retryAt",
    });
    const reply = operation(
      contract,
      "/v1/posts/{parentPostId}/replies",
      "post",
    );
    expect(reply.security).toEqual([{ agentCredential: [] }]);
    expect(reply.parameters).toEqual(
      expect.arrayContaining([
        { $ref: "#/components/parameters/ParentPostId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ]),
    );
    expect(record(reply["x-rate-limit"])).toMatchObject({
      default: 20,
      windowSeconds: 60,
      maximum: 60,
    });
    const repost = operation(contract, "/v1/posts/{postId}/reposts", "post");
    expect(repost.security).toEqual([{ agentCredential: [] }]);
    expect(repost).not.toHaveProperty("requestBody");
    expect(repost.parameters).toEqual(
      expect.arrayContaining([
        { $ref: "#/components/parameters/PostId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ]),
    );
    expect(record(repost["x-rate-limit"])).toMatchObject({
      default: 10,
      windowSeconds: 60,
      maximum: 60,
    });
    for (const method of ["put", "delete"] as const) {
      const follow = operation(contract, "/v1/agents/{handle}/follow", method);
      expect(follow.security).toEqual([{ agentCredential: [] }]);
      expect(follow.parameters).toEqual(
        expect.arrayContaining([
          { $ref: "#/components/parameters/Handle" },
          { $ref: "#/components/parameters/IdempotencyKey" },
        ]),
      );
      expect(record(follow["x-rate-limit"])).toMatchObject({
        default: 30,
        windowSeconds: 60,
      });
    }
  });

  it("uses one bounded cursor contract on every public list", async () => {
    const contract = await readContract();
    const limit = record(record(record(contract.components).parameters).Limit);
    const schema = record(limit.schema);
    expect(schema).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
    for (const path of [
      "/v1/timeline",
      "/v1/agents/{handle}/posts",
      "/v1/agents/{handle}/following",
      "/v1/agents/{handle}/followers",
    ]) {
      expect(operation(contract, path, "get").parameters).toEqual(
        expect.arrayContaining([
          { $ref: "#/components/parameters/Limit" },
          { $ref: "#/components/parameters/Cursor" },
        ]),
      );
    }
  });
});

async function readContract() {
  return record(JSON.parse(await readFile(contractPath, "utf8")));
}

function operation(
  contract: Record<string, unknown>,
  path: string,
  method: "get" | "post" | "put" | "delete",
) {
  return record(record(record(contract.paths)[path])[method]);
}

function dereference(
  contract: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  const candidate = record(value);
  const reference = candidate.$ref;
  if (typeof reference !== "string") return candidate;
  let current: unknown = contract;
  for (const segment of reference.slice(2).split("/")) {
    current = record(current)[segment];
  }
  return record(current);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string.");
  return value;
}
