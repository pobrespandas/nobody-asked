import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyHostedOperatorAuthorization } from "./hosted-operator-authorization.js";
afterEach(() => vi.unstubAllGlobals());
const input = {
  baseUrl: new URL("http://127.0.0.1/"),
  origin: "https://operator.example",
  operatorId: "operator-private",
  operatorCookie: "__session=private-cookie",
};
describe("memory-only hosted Operator verification", () => {
  it.each([
    { operatorCookie: "operator_session=private-cookie" },
    { operatorCookie: "__session=private\r\ncookie" },
    { origin: "https://operator.example/path" },
  ])("rejects unsafe inputs before network access", async (change) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      verifyHostedOperatorAuthorization({ ...input, ...change }),
    ).rejects.toThrow(/^Invalid Operator verification input\.$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns a sanitized failure report when discovery fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private-cookie private-identity provider failure");
      }),
    );
    const report = await verifyHostedOperatorAuthorization(input);
    expect(report).toMatchObject({
      result: "fail",
      phase: "discovery",
      agentId: null,
      cleanup: "not-created",
      unverified: expect.arrayContaining(["distinct_operator_reauthorization"]),
    });
    expect(JSON.stringify(report)).not.toMatch(
      /private-cookie|private-identity|provider failure|operator-private/,
    );
  });
  it("does not claim no Agent was created after an uncertain registration response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (url.pathname === "/v1")
          return Response.json({ contract: { href: "/v1/openapi.json" } });
        if (url.pathname === "/v1/openapi.json")
          return Response.json({
            paths: {
              "/v1/agent-registrations": {
                post: {
                  operationId: "startAgentRegistration",
                  tags: ["Agent commands"],
                },
              },
              "/v1/agents/{handle}": {
                get: { operationId: "getAgent", tags: ["Public reads"] },
              },
            },
          });
        if (url.pathname.startsWith("/v1/agents/"))
          return Response.json(
            { error: { code: "agent_not_found" } },
            { status: 404 },
          );
        throw new Error("Private transport details");
      }),
    );
    const report = await verifyHostedOperatorAuthorization(input);
    expect(report).toMatchObject({
      result: "fail",
      phase: "registration",
      agentId: null,
      cleanup: "cleanup_requires_review",
    });
    expect(JSON.stringify(report)).not.toContain("Private transport details");
  });
  it("finds an uncertain completed registration by handle and signs fresh cleanup proofs", async () => {
    const schema = {
      type: "object",
      properties: { data: { type: "object", properties: {} } },
      required: ["data"],
    };
    const operation = (
      operationId: string,
      method: string,
      status: number,
      tags: string[],
    ) => ({
      [method]: {
        operationId,
        tags,
        responses: {
          [status]: { content: { "application/json": { schema } } },
        },
      },
    });
    const contract = {
      paths: {
        "/v1/agent-registrations": operation(
          "startAgentRegistration",
          "post",
          201,
          ["Agent commands"],
        ),
        "/v1/agent-registrations/{registrationId}/complete": operation(
          "completeAgentRegistration",
          "post",
          201,
          ["Agent commands"],
        ),
        "/v1/agents/{handle}": operation("getAgent", "get", 200, [
          "Public reads",
        ]),
        "/v1/agents/{agentId}/recovery-challenges": operation(
          "startAgentRecovery",
          "post",
          201,
          ["Agent commands"],
        ),
        "/v1/agents/{agentId}/recovery-challenges/{challengeId}/complete":
          operation("completeAgentRecovery", "post", 200, ["Agent commands"]),
      },
    };
    const completed: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, options?: RequestInit) => {
        if (url.pathname === "/v1")
          return Response.json({ contract: { href: "/v1/openapi.json" } });
        if (url.pathname === "/v1/openapi.json") return Response.json(contract);
        if (url.pathname === "/v1/agent-registrations")
          return Response.json(
            {
              data: {
                registrationId: "registration-1",
                challenge: "registration-challenge",
                proof: { message: "registration-proof" },
              },
            },
            { status: 201 },
          );
        if (url.pathname.includes("agent-registrations/"))
          throw Object.assign(new Error("private timeout details"), {
            name: "AbortError",
          });
        if (url.pathname.endsWith("/recovery-challenges")) {
          const body = JSON.parse(String(options?.body));
          return Response.json(
            {
              data: {
                challengeId: "cleanup-challenge",
                challenge: "cleanup-challenge-value",
                proof: { message: "cleanup-proof" },
                ...(body.operation === "remove_operator_authorization"
                  ? { authorizationRevision: 0 }
                  : {}),
              },
            },
            { status: 201 },
          );
        }
        if (url.pathname.endsWith("/complete")) {
          const body = JSON.parse(String(options?.body));
          completed.push(body);
          return Response.json({
            data: {
              status: body.operation === "stop_agent" ? "stopped" : "active",
            },
          });
        }
        return Response.json({
          data: { id: "synthetic-agent", status: "active" },
        });
      }),
    );
    const report = await verifyHostedOperatorAuthorization(input);
    expect(report).toMatchObject({
      result: "fail",
      phase: "registration",
      agentId: "synthetic-agent",
      cleanup: "stopped",
    });
    expect(completed.map((body) => body.operation)).toEqual([
      "remove_operator_authorization",
      "stop_agent",
    ]);
    expect(
      completed.every(
        (body) =>
          typeof body.signature === "string" && body.signature.length > 0,
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(
      /private-cookie|private timeout|cleanup-proof|cleanup-challenge/,
    );
  });
});
