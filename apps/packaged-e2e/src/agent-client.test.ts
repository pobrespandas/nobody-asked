import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAgentClient } from "./agent-client.js";
afterEach(() => vi.unstubAllGlobals());
async function client(extra: Record<string, unknown> = {}) {
  const operation = (operationId: string, audience?: string) => ({
    get: {
      operationId,
      tags: ["Agent reads"],
      security: [{ agentCredential: [] }],
      ...(audience === undefined ? {} : { "x-capability-audience": audience }),
    },
  });
  const contract = {
    paths: {
      "/v1/me": operation("getAuthenticatedAgent"),
      "/v1/me/operator-authorization": operation(
        "getAgentOperatorAuthorization",
        "optional-operator",
      ),
      ...extra,
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL) =>
      Response.json(
        input.pathname === "/v1"
          ? { contract: { href: "/v1/openapi.json" } }
          : input.pathname === "/v1/openapi.json"
            ? contract
            : { data: {} },
      ),
    ),
  );
  return HttpAgentClient.discover(
    new URL("http://127.0.0.1/"),
    "fixture-credential",
  );
}
describe("explicit conformance audiences", () => {
  it("keeps default coverage strict and names skipped optional operation IDs", async () => {
    const api = await client();
    await api.identify();
    expect(() => api.assertEveryDiscoveredCapabilityWasExercised()).toThrow(
      "getAgentOperatorAuthorization",
    );
    expect(api.assertAutonomousCapabilitiesWereExercised()).toEqual([
      "getAgentOperatorAuthorization",
    ]);
    await api.readOperatorAuthorization();
    expect(() =>
      api.assertEveryDiscoveredCapabilityWasExercised(),
    ).not.toThrow();
  });
  it("does not silently exclude a new unclassified Agent operation", async () => {
    const api = await client({
      "/v1/new": {
        get: { operationId: "newAgentCapability", tags: ["Agent reads"] },
      },
    });
    await api.identify();
    expect(() => api.assertAutonomousCapabilitiesWereExercised()).toThrow(
      "newAgentCapability",
    );
  });
  it("rejects an unknown audience instead of treating it as optional", async () => {
    await expect(
      client({
        "/v1/new": {
          get: {
            operationId: "unknownAudience",
            tags: ["Agent reads"],
            "x-capability-audience": "skip-me",
          },
        },
      }),
    ).rejects.toThrow("audience is invalid");
  });
});
