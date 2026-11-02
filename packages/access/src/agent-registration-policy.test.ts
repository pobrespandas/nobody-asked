import { describe, expect, it } from "vitest";

import {
  AGENT_PROOF_LIFETIME_MS,
  closeAgentRegistrationCircuitBreaker,
  decideAgentRegistrationStart,
  DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY,
  MAXIMUM_REGISTRATION_CHALLENGE_LIFETIME_MS,
  openAgentRegistrationCircuitBreaker,
  type AgentRegistrationLimitPolicy,
  type AgentRegistrationLimitState,
} from "./index.js";

const at = new Date("2026-11-02T12:00:00.000Z");
const windowStartedAt = new Date("2026-11-02T11:55:00.000Z");

describe("autonomous Agent registration limits", () => {
  it("allows one start and returns the bounded challenge expiration", () => {
    const decision = decideAgentRegistrationStart({ state: state(), at });

    expect(decision).toEqual({
      allowed: true,
      challengeExpiresAt: new Date(at.getTime() + AGENT_PROOF_LIFETIME_MS),
    });
    expect(DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY.challengeLifetimeMs).toBe(
      MAXIMUM_REGISTRATION_CHALLENGE_LIFETIME_MS,
    );
  });

  it("rejects the network source at its limit until the fixed window ends", () => {
    const policy = testPolicy({ networkSourceLimit: 2 });
    const decision = decideAgentRegistrationStart({
      policy,
      state: state({ networkSource: bucket(2) }),
      at,
    });

    expect(decision).toEqual({
      allowed: false,
      code: "registration_network_source_limited",
      retryAt: new Date(windowStartedAt.getTime() + policy.windowMs),
    });
  });

  it("rejects all sources at the global limit", () => {
    const policy = testPolicy({ globalLimit: 20 });

    expect(
      decideAgentRegistrationStart({
        policy,
        state: state({ global: bucket(20) }),
        at,
      }),
    ).toEqual({
      allowed: false,
      code: "registration_global_limited",
      retryAt: new Date(windowStartedAt.getTime() + policy.windowMs),
    });
  });

  it("starts a new count after a fixed window expires", () => {
    const policy = testPolicy({
      networkSourceLimit: 1,
      globalLimit: 1,
      windowMs: 60_000,
    });

    expect(
      decideAgentRegistrationStart({
        policy,
        state: state({ networkSource: bucket(1), global: bucket(1) }),
        at,
      }).allowed,
    ).toBe(true);
  });

  it.each([
    {
      override: { incompleteForNetworkSource: 2, incompleteGlobal: 2 },
      policy: { networkSourceIncompleteLimit: 2 },
      code: "registration_network_source_capacity_reached",
    },
    {
      override: { incompleteGlobal: 8 },
      policy: { globalIncompleteLimit: 8 },
      code: "registration_global_capacity_reached",
    },
  ] as const)("bounds incomplete registrations with $code", (example) => {
    expect(
      decideAgentRegistrationStart({
        policy: testPolicy(example.policy),
        state: state(example.override),
        at,
      }),
    ).toEqual({ allowed: false, code: example.code, retryAt: null });
  });

  it("accepts a shorter challenge lifetime and rejects a longer one", () => {
    const shorter = testPolicy({ challengeLifetimeMs: 60_000 });
    expect(
      decideAgentRegistrationStart({ policy: shorter, state: state(), at }),
    ).toEqual({
      allowed: true,
      challengeExpiresAt: new Date(at.getTime() + 60_000),
    });

    expect(() =>
      decideAgentRegistrationStart({
        policy: testPolicy({
          challengeLifetimeMs: MAXIMUM_REGISTRATION_CHALLENGE_LIFETIME_MS + 1,
        }),
        state: state(),
        at,
      }),
    ).toThrow("supported short range");
  });

  it("rejects a deployment limit above the code maximum", () => {
    expect(() =>
      decideAgentRegistrationStart({
        policy: testPolicy({ networkSourceLimit: 101 }),
        state: state(),
        at,
      }),
    ).toThrow("exceeds the safe maximum");
  });

  it("blocks every start while the deployment circuit is open", () => {
    const circuitBreaker = openAgentRegistrationCircuitBreaker({
      at,
      reason: "incident",
    });

    expect(
      decideAgentRegistrationStart({
        state: state({ circuitBreaker }),
        at,
      }),
    ).toEqual({
      allowed: false,
      code: "registration_circuit_open",
      retryAt: null,
    });
    expect(closeAgentRegistrationCircuitBreaker()).toEqual({
      state: "closed",
    });
  });

  it("rejects impossible counter state", () => {
    expect(() =>
      decideAgentRegistrationStart({
        state: state({
          incompleteForNetworkSource: 2,
          incompleteGlobal: 1,
        }),
        at,
      }),
    ).toThrow("must include the network-source count");
  });
});

function state(
  override: Partial<AgentRegistrationLimitState> = {},
): AgentRegistrationLimitState {
  return {
    networkSource: bucket(0),
    global: bucket(0),
    incompleteForNetworkSource: 0,
    incompleteGlobal: 0,
    circuitBreaker: closeAgentRegistrationCircuitBreaker(),
    ...override,
  };
}

function bucket(count: number) {
  return { count, windowStartedAt };
}

function testPolicy(
  override: Partial<AgentRegistrationLimitPolicy> = {},
): AgentRegistrationLimitPolicy {
  return {
    ...DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY,
    ...override,
  };
}
