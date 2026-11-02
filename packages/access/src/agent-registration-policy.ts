import { AGENT_PROOF_LIFETIME_MS } from "./agent-registration.js";

export const REGISTRATION_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
export const REGISTRATION_NETWORK_SOURCE_LIMIT = 10;
export const REGISTRATION_GLOBAL_LIMIT = 500;
export const REGISTRATION_NETWORK_SOURCE_INCOMPLETE_LIMIT = 5;
export const REGISTRATION_GLOBAL_INCOMPLETE_LIMIT = 100;
export const MAXIMUM_REGISTRATION_NETWORK_SOURCE_LIMIT = 100;
export const MAXIMUM_REGISTRATION_GLOBAL_LIMIT = 5_000;
export const MAXIMUM_REGISTRATION_NETWORK_SOURCE_INCOMPLETE_LIMIT = 20;
export const MAXIMUM_REGISTRATION_GLOBAL_INCOMPLETE_LIMIT = 500;
export const MINIMUM_REGISTRATION_CHALLENGE_LIFETIME_MS = 30 * 1_000;
export const MAXIMUM_REGISTRATION_CHALLENGE_LIFETIME_MS =
  AGENT_PROOF_LIFETIME_MS;

export interface AgentRegistrationLimitPolicy {
  readonly windowMs: number;
  readonly networkSourceLimit: number;
  readonly globalLimit: number;
  readonly networkSourceIncompleteLimit: number;
  readonly globalIncompleteLimit: number;
  readonly challengeLifetimeMs: number;
}

export const DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY = Object.freeze({
  windowMs: REGISTRATION_LIMIT_WINDOW_MS,
  networkSourceLimit: REGISTRATION_NETWORK_SOURCE_LIMIT,
  globalLimit: REGISTRATION_GLOBAL_LIMIT,
  networkSourceIncompleteLimit: REGISTRATION_NETWORK_SOURCE_INCOMPLETE_LIMIT,
  globalIncompleteLimit: REGISTRATION_GLOBAL_INCOMPLETE_LIMIT,
  challengeLifetimeMs: AGENT_PROOF_LIFETIME_MS,
}) satisfies AgentRegistrationLimitPolicy;

export interface RegistrationLimitBucket {
  readonly count: number;
  readonly windowStartedAt: Date;
}

export type AgentRegistrationCircuitBreakerState =
  | { readonly state: "closed" }
  | {
      readonly state: "open";
      readonly openedAt: Date;
      readonly reason: "abuse" | "capacity" | "incident";
    };

export interface AgentRegistrationLimitState {
  readonly networkSource: RegistrationLimitBucket;
  readonly global: RegistrationLimitBucket;
  readonly incompleteForNetworkSource: number;
  readonly incompleteGlobal: number;
  readonly circuitBreaker: AgentRegistrationCircuitBreakerState;
}

export type AgentRegistrationLimitRejectionCode =
  | "registration_circuit_open"
  | "registration_global_capacity_reached"
  | "registration_global_limited"
  | "registration_network_source_capacity_reached"
  | "registration_network_source_limited";

export type AgentRegistrationStartDecision =
  | {
      readonly allowed: true;
      readonly challengeExpiresAt: Date;
    }
  | {
      readonly allowed: false;
      readonly code: AgentRegistrationLimitRejectionCode;
      readonly retryAt: Date | null;
    };

export function decideAgentRegistrationStart(input: {
  readonly policy?: AgentRegistrationLimitPolicy;
  readonly state: AgentRegistrationLimitState;
  readonly at: Date;
}): AgentRegistrationStartDecision {
  const policy = input.policy ?? DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY;
  assertPolicy(policy);
  assertDate(input.at, "Registration decision time");
  assertState(input.state);

  if (input.state.circuitBreaker.state === "open") {
    return rejection("registration_circuit_open", null);
  }
  if (
    input.state.incompleteForNetworkSource >=
    policy.networkSourceIncompleteLimit
  ) {
    return rejection("registration_network_source_capacity_reached", null);
  }
  if (input.state.incompleteGlobal >= policy.globalIncompleteLimit) {
    return rejection("registration_global_capacity_reached", null);
  }

  const networkSourceCount = countInCurrentWindow(
    input.state.networkSource,
    input.at,
    policy.windowMs,
  );
  if (networkSourceCount >= policy.networkSourceLimit) {
    return rejection(
      "registration_network_source_limited",
      windowEnd(input.state.networkSource, policy.windowMs),
    );
  }

  const globalCount = countInCurrentWindow(
    input.state.global,
    input.at,
    policy.windowMs,
  );
  if (globalCount >= policy.globalLimit) {
    return rejection(
      "registration_global_limited",
      windowEnd(input.state.global, policy.windowMs),
    );
  }

  return Object.freeze({
    allowed: true,
    challengeExpiresAt: new Date(
      input.at.getTime() + policy.challengeLifetimeMs,
    ),
  });
}

export function openAgentRegistrationCircuitBreaker(input: {
  readonly at: Date;
  readonly reason: Exclude<
    AgentRegistrationCircuitBreakerState,
    { readonly state: "closed" }
  >["reason"];
}): AgentRegistrationCircuitBreakerState {
  assertDate(input.at, "Circuit breaker time");
  return Object.freeze({
    state: "open",
    openedAt: new Date(input.at),
    reason: input.reason,
  });
}

export function closeAgentRegistrationCircuitBreaker(): AgentRegistrationCircuitBreakerState {
  return Object.freeze({ state: "closed" });
}

function assertPolicy(policy: AgentRegistrationLimitPolicy): void {
  assertPositiveInteger(policy.windowMs, "Registration limit window");
  assertPositiveInteger(
    policy.networkSourceLimit,
    "Registration network-source limit",
  );
  assertPositiveInteger(policy.globalLimit, "Registration global limit");
  assertPositiveInteger(
    policy.networkSourceIncompleteLimit,
    "Incomplete network-source limit",
  );
  assertPositiveInteger(
    policy.globalIncompleteLimit,
    "Incomplete global limit",
  );
  assertMaximum(
    policy.networkSourceLimit,
    MAXIMUM_REGISTRATION_NETWORK_SOURCE_LIMIT,
    "Registration network-source limit",
  );
  assertMaximum(
    policy.globalLimit,
    MAXIMUM_REGISTRATION_GLOBAL_LIMIT,
    "Registration global limit",
  );
  assertMaximum(
    policy.networkSourceIncompleteLimit,
    MAXIMUM_REGISTRATION_NETWORK_SOURCE_INCOMPLETE_LIMIT,
    "Incomplete network-source limit",
  );
  assertMaximum(
    policy.globalIncompleteLimit,
    MAXIMUM_REGISTRATION_GLOBAL_INCOMPLETE_LIMIT,
    "Incomplete global limit",
  );
  if (policy.globalLimit < policy.networkSourceLimit) {
    throw new TypeError(
      "The global registration limit must not be below the network-source limit.",
    );
  }
  if (policy.globalIncompleteLimit < policy.networkSourceIncompleteLimit) {
    throw new TypeError(
      "The global incomplete limit must not be below the network-source incomplete limit.",
    );
  }
  if (
    !Number.isSafeInteger(policy.challengeLifetimeMs) ||
    policy.challengeLifetimeMs < MINIMUM_REGISTRATION_CHALLENGE_LIFETIME_MS ||
    policy.challengeLifetimeMs > MAXIMUM_REGISTRATION_CHALLENGE_LIFETIME_MS
  ) {
    throw new TypeError(
      "The registration challenge lifetime must use the supported short range.",
    );
  }
}

function assertState(state: AgentRegistrationLimitState): void {
  assertBucket(state.networkSource, "Network-source registration bucket");
  assertBucket(state.global, "Global registration bucket");
  assertNonNegativeInteger(
    state.incompleteForNetworkSource,
    "Incomplete network-source count",
  );
  assertNonNegativeInteger(state.incompleteGlobal, "Incomplete global count");
  if (state.incompleteGlobal < state.incompleteForNetworkSource) {
    throw new TypeError(
      "The global incomplete count must include the network-source count.",
    );
  }
  if (state.circuitBreaker.state === "open") {
    assertDate(state.circuitBreaker.openedAt, "Circuit breaker open time");
    if (
      !(["abuse", "capacity", "incident"] as const).includes(
        state.circuitBreaker.reason,
      )
    ) {
      throw new TypeError("The circuit breaker reason is invalid.");
    }
  }
}

function assertBucket(bucket: RegistrationLimitBucket, label: string): void {
  assertNonNegativeInteger(bucket.count, `${label} count`);
  assertDate(bucket.windowStartedAt, `${label} start`);
}

function countInCurrentWindow(
  bucket: RegistrationLimitBucket,
  at: Date,
  windowMs: number,
): number {
  return at.getTime() < bucket.windowStartedAt.getTime() + windowMs
    ? bucket.count
    : 0;
}

function windowEnd(bucket: RegistrationLimitBucket, windowMs: number): Date {
  return new Date(bucket.windowStartedAt.getTime() + windowMs);
}

function rejection(
  code: AgentRegistrationLimitRejectionCode,
  retryAt: Date | null,
): AgentRegistrationStartDecision {
  return Object.freeze({ code, allowed: false, retryAt });
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

function assertMaximum(value: number, maximum: number, label: string): void {
  if (value > maximum) {
    throw new TypeError(`${label} exceeds the safe maximum.`);
  }
}

function assertDate(value: Date, label: string): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} must be a valid date.`);
  }
}
