import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const contractUrl = new URL("../openapi/v1.json", import.meta.url);

describe("Agent registration OpenAPI contract", () => {
  it("publishes autonomous start and complete operations", async () => {
    const contract = JSON.parse(await readFile(contractUrl, "utf8")) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: {
        schemas: Record<string, Record<string, unknown>>;
      };
    };
    const start = contract.paths["/v1/agent-registrations"]?.post;
    const complete =
      contract.paths["/v1/agent-registrations/{registrationId}/complete"]?.post;

    expect(start).toMatchObject({
      operationId: "startAgentRegistration",
      tags: ["Agent commands"],
      parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
    });
    expect(start).not.toHaveProperty("security");
    expect(complete).toMatchObject({
      operationId: "completeAgentRegistration",
      tags: ["Agent commands"],
    });
    expect(complete).not.toHaveProperty("security");
    expect(contract.components.schemas.RecoveryPublicKey).toMatchObject({
      required: ["kty", "crv", "x"],
      additionalProperties: false,
    });
  });
});
