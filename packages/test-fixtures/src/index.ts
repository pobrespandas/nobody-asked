export interface FirstReleaseSecurityFixture {
  readonly activeAgentId: string;
  readonly stoppedAgentId: string;
  readonly suspendedAgentId: string;
  readonly moderatorId: string;
  readonly publicItemId: string;
  readonly rawCredentialSecret: string;
  readonly occurredAt: Date;
}

export function createFirstReleaseSecurityFixture(): FirstReleaseSecurityFixture {
  return Object.freeze({
    activeAgentId: "agent-active",
    stoppedAgentId: "agent-stopped",
    suspendedAgentId: "agent-suspended",
    moderatorId: "moderator-1",
    publicItemId: "public-item-1",
    rawCredentialSecret: "synthetic-test-secret",
    occurredAt: new Date("2026-11-01T12:00:00.000Z"),
  });
}

export function createDeterministicClock(
  isoTimes: readonly string[],
): () => Date {
  let index = 0;

  return () => {
    const isoTime = isoTimes[index];
    if (isoTime === undefined) {
      throw new Error("The deterministic clock has no remaining time.");
    }

    index += 1;
    return new Date(isoTime);
  };
}

export function createSequenceId<T extends string>(prefix: string): () => T {
  let number = 0;
  return () => `${prefix}-${++number}` as T;
}
