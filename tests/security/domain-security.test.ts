import {
  AgentAccessBlockedError,
  type AgentId as AccessAgentId,
  type CredentialId,
  issueCredential,
} from "@nobody-asked/access";
import {
  type AgentId as SafetyAgentId,
  type AuditRecordId,
  type ModeratorId,
  type PublicItemId,
  SafetyDomain,
} from "@nobody-asked/safety";
import {
  createDeterministicClock,
  createFirstReleaseSecurityFixture,
  createSequenceId,
} from "@nobody-asked/test-fixtures";
import { describe, expect, it } from "vitest";

describe("security boundaries", () => {
  it.each(["stopped", "suspended"] as const)(
    "blocks credential issuance for a %s agent",
    (status) => {
      const fixture = createFirstReleaseSecurityFixture();

      expect(() =>
        issueCredential(
          {
            nextCredentialId: createSequenceId<CredentialId>("credential"),
            generateSecret: () => fixture.rawCredentialSecret,
            digestSecret: (secret) => `digest:${secret}`,
            now: () => new Date(fixture.occurredAt),
          },
          {
            agent: {
              id: (status === "stopped"
                ? fixture.stoppedAgentId
                : fixture.suspendedAgentId) as AccessAgentId,
              status,
            },
            credentials: [],
          },
        ),
      ).toThrow(AgentAccessBlockedError);
    },
  );

  it("keeps moderation authority and notes out of public state", () => {
    const fixture = createFirstReleaseSecurityFixture();
    const domain = new SafetyDomain({
      nextReportId: createSequenceId("report"),
      nextAuditRecordId: createSequenceId<AuditRecordId>("audit"),
      now: createDeterministicClock([fixture.occurredAt.toISOString()]),
    });

    const change = domain.hideContent({
      publicItemId: fixture.publicItemId as PublicItemId,
      moderatorId: fixture.moderatorId as ModeratorId,
      reasonCategory: "abuse",
      internalNote: "Synthetic private moderation note.",
      correlationId: "request-1",
    });
    const publicState = domain.projectContentPublicState(
      fixture.publicItemId as PublicItemId,
    );

    expect(change.audit).toMatchObject({
      moderatorId: fixture.moderatorId,
      internalNote: "Synthetic private moderation note.",
      correlationId: "request-1",
    });
    expect(publicState).not.toHaveProperty("moderatorId");
    expect(publicState).not.toHaveProperty("internalNote");
    expect(publicState).not.toHaveProperty("correlationId");
  });

  it("preserves a stopped state across suspension and restoration", () => {
    const fixture = createFirstReleaseSecurityFixture();
    const domain = new SafetyDomain({
      nextReportId: createSequenceId("report"),
      nextAuditRecordId: createSequenceId<AuditRecordId>("audit"),
      now: createDeterministicClock([
        fixture.occurredAt.toISOString(),
        "2026-11-01T12:01:00.000Z",
      ]),
    });
    const agentId = fixture.stoppedAgentId as SafetyAgentId;
    const context = {
      moderatorId: fixture.moderatorId as ModeratorId,
      reasonCategory: "abuse" as const,
      correlationId: "request-2",
    };

    domain.suspendAgent({ agentId, currentStatus: "stopped", ...context });
    const restored = domain.restoreAgent({ agentId, ...context });

    expect(restored.state).toEqual({ agentId, status: "stopped" });
  });
});
