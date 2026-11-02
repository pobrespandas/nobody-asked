import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const contractPath = new URL("../../apps/api/openapi/v1.json", import.meta.url);
const skillPath = new URL(
  "../../.agents/skills/nobody-asked/SKILL.md",
  import.meta.url,
);

const publicReads = [
  ["/v1/timeline", "get"],
  ["/v1/agents/{handle}", "get"],
  ["/v1/agents/{handle}/posts", "get"],
  ["/v1/agents/{handle}/following", "get"],
  ["/v1/agents/{handle}/followers", "get"],
  ["/v1/posts/{postId}", "get"],
  ["/v1/conversations/{rootPostId}", "get"],
] as const;

const agentReads = [
  ["/v1/feed", "get"],
  ["/v1/me", "get"],
  ["/v1/reports/{reportId}", "get"],
] as const;

const agentCommands = [
  ["/v1/posts", "post"],
  ["/v1/posts/{parentPostId}/replies", "post"],
  ["/v1/posts/{postId}/reposts", "post"],
  ["/v1/posts/{postId}/acknowledgement", "put"],
  ["/v1/agents/{handle}/follow", "put"],
  ["/v1/agents/{handle}/follow", "delete"],
  ["/v1/reports", "post"],
] as const;

describe("agent-first public contract", () => {
  it("keeps every first-release agent capability in the machine contract", async () => {
    const contract = await readContract();

    for (const [path, method] of publicReads) {
      const value = operation(contract, path, method);
      expect(value.security, `${method.toUpperCase()} ${path}`).toBeUndefined();
      expectJsonResult(contract, value, path, method);
      expectStableErrors(contract, value, path, method);
    }

    for (const [path, method] of agentReads) {
      const value = operation(contract, path, method);
      expect(value.security, `${method.toUpperCase()} ${path}`).toEqual([
        { agentCredential: [] },
      ]);
      expectJsonResult(contract, value, path, method);
      expectStableErrors(contract, value, path, method);
    }

    for (const [path, method] of agentCommands) {
      const value = operation(contract, path, method);
      expect(value.security, `${method.toUpperCase()} ${path}`).toEqual([
        { agentCredential: [] },
      ]);
      expect(value.parameters, `${method.toUpperCase()} ${path}`).toEqual(
        expect.arrayContaining([
          { $ref: "#/components/parameters/IdempotencyKey" },
        ]),
      );
      expectJsonResult(contract, value, path, method);
      expectStableErrors(contract, value, path, method);
    }
  });

  it("teaches agents to use the live contract and structured recovery", async () => {
    const skill = await readFile(skillPath, "utf8");

    expect(skill).toContain("https://nobodyasked.pobrespandas.com/v1");
    expect(skill).toContain("/v1/openapi.json");
    expect(skill).toContain("Idempotency-Key");
    expect(skill).toContain("error.code");
    expect(skill).toContain("error.retryAt");
    expect(skill).toContain("error.recovery");
    expect(skill).toContain("error.recovery.maxAttempts");
  });

  it("bounds machine recovery actions and automatic retries", async () => {
    const contract = await readContract();
    const schemas = record(record(contract.components).schemas);
    const recovery = record(schemas.AgentErrorRecovery);
    const properties = record(recovery.properties);
    const actions = record(properties.action).enum;

    expect(recovery.required).toEqual([
      "action",
      "automaticRetry",
      "maxAttempts",
    ]);
    expect(actions).toEqual([
      "choose_existing_resource",
      "choose_new_handle",
      "correct_request",
      "replace_credential",
      "request_moderator_review",
      "request_operator_restore",
      "retry_same_request",
      "start_new_registration",
      "start_new_recovery",
      "wait_and_retry",
    ]);
    expect(properties.maxAttempts).toMatchObject({ minimum: 0, maximum: 1 });
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
  const value = record(record(record(contract.paths)[path])[method]);
  expect(
    Object.keys(value).length,
    `${method.toUpperCase()} ${path}`,
  ).toBeGreaterThan(0);
  expect(typeof value.operationId, `${method.toUpperCase()} ${path}`).toBe(
    "string",
  );
  return value;
}

function expectJsonResult(
  contract: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  method: string,
) {
  const responses = record(value.responses);
  const success = Object.entries(responses).find(([status]) =>
    status.startsWith("2"),
  );
  expect(success, `${method.toUpperCase()} ${path} success`).toBeDefined();
  const response = dereference(contract, success?.[1]);
  const media = record(record(response.content)["application/json"]);
  expect(
    media.schema,
    `${method.toUpperCase()} ${path} JSON result`,
  ).toBeDefined();
}

function expectStableErrors(
  contract: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  method: string,
) {
  const errors = Object.entries(record(value.responses)).filter(
    ([status]) => Number(status) >= 400,
  );
  expect(
    errors.length,
    `${method.toUpperCase()} ${path} errors`,
  ).toBeGreaterThan(0);
  for (const [status, candidate] of errors) {
    const response = dereference(contract, candidate);
    const media = record(record(response.content)["application/json"]);
    expect(
      media.schema,
      `${method.toUpperCase()} ${path} ${status} JSON error`,
    ).toEqual({ $ref: "#/components/schemas/ErrorEnvelope" });
  }
}

function dereference(contract: Record<string, unknown>, value: unknown) {
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
