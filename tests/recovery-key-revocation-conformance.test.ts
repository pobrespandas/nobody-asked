import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAgentClient } from "../apps/packaged-e2e/src/agent-client.js";
import { runRecoveryKeyRevocationConformance } from "../apps/packaged-e2e/src/recovery-key-revocation-conformance.js";

vi.mock("../apps/packaged-e2e/src/contract-assertions.js", () => ({
  assertOperationResponseMatchesContract: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

function harness(allowOldProof = false) {
  let epoch = 1;
  let stopped = false;
  let id = 0;
  let rejections = 0;
  let replays = 0;
  const challenges = new Map<
    string,
    { epoch: number; operation: string; response?: unknown }
  >();
  const output: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) =>
    output.push(String(line)),
  );
  vi.spyOn(console, "error").mockImplementation((line) =>
    errors.push(String(line)),
  );
  const client = {
    contract: {},
    startRegistration: vi.fn(async () => ({
      status: 201,
      body: {
        data: {
          registrationId: "register",
          challenge: "private-challenge",
          proof: { message: "private-proof" },
        },
      },
    })),
    completeRegistration: vi.fn(async () => ({
      status: 201,
      body: {
        data: { agentId: "public-agent", credential: "private-credential" },
      },
    })),
    useCredential: vi.fn(),
    identify: vi.fn(async () =>
      stopped
        ? { status: 401, body: { error: { code: "invalid_credential" } } }
        : {
            status: 200,
            body: { data: { agent: { id: "public-agent", status: "active" } } },
          },
    ),
    startRecovery: vi.fn(
      async (_agent: string, _key: string, operation: string) => {
        const challengeId = String(++id);
        challenges.set(challengeId, { epoch, operation });
        return {
          status: 201,
          body: {
            data: {
              challengeId,
              challenge: "private-challenge",
              proof: { message: "private-proof" },
            },
          },
        };
      },
    ),
    completeRecovery: vi.fn(async (_agent: string, challengeId: string) => {
      const challenge = challenges.get(challengeId)!;
      if (challenge.response) {
        replays++;
        return { status: 200, body: challenge.response };
      }
      if (challenge.epoch !== epoch) {
        if (allowOldProof)
          return {
            status: 200,
            body: { data: { credential: "private-leaked-credential" } },
          };
        rejections++;
        return {
          status: 401,
          body: { error: { code: "recovery_proof_rejected" } },
        };
      }
      if (challenge.operation === "replace_recovery_key") epoch++;
      if (challenge.operation === "stop_agent") stopped = true;
      challenge.response = {
        data: {
          agentId: "public-agent",
          status: stopped ? "stopped" : "active",
          operation: challenge.operation,
        },
      };
      return { status: 200, body: challenge.response };
    }),
  };
  vi.spyOn(HttpAgentClient, "discover").mockResolvedValue(
    client as unknown as HttpAgentClient,
  );
  return {
    client,
    output,
    errors,
    state: () => ({ stopped, rejections, replays }),
  };
}

describe("Recovery key revocation conformance", () => {
  it("checks all old proofs before and after restoring the public key and cleans up", async () => {
    const h = harness();
    expect(
      await runRecoveryKeyRevocationConformance(
        new URL("https://candidate.test"),
      ),
    ).toBe(true);
    expect(h.state()).toEqual({ stopped: true, rejections: 6, replays: 2 });
    expect(h.client.useCredential).toHaveBeenCalledTimes(1);
    expect(h.errors).toEqual([]);
    expect(JSON.parse(h.output[0]!).checks).toContain(
      "reject_old_proofs_restored_public_key",
    );
    expect(h.output.join(" ")).not.toMatch(
      /private-|"signature"|"credential"|"proof"/,
    );
  });
  it("fails on the original regression and still stops the Agent without secret output", async () => {
    const h = harness(true);
    expect(
      await runRecoveryKeyRevocationConformance(
        new URL("https://candidate.test"),
      ),
    ).toBe(false);
    expect(h.state().stopped).toBe(true);
    expect(h.errors.join(" ")).toContain("reject_old_proofs_revoked_key");
    expect(h.errors.join(" ")).not.toMatch(/private-|leaked-credential/);
  });
  it("sanitizes transport failure and performs fresh-key cleanup", async () => {
    const h = harness();
    h.client.identify.mockRejectedValueOnce(
      new Error("private-credential private-proof"),
    );
    expect(
      await runRecoveryKeyRevocationConformance(
        new URL("https://candidate.test"),
      ),
    ).toBe(false);
    expect(h.state().stopped).toBe(true);
    expect(h.errors.join(" ")).not.toMatch(/private-/);
  });
});
