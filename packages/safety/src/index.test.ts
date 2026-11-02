import { describe, expect, it, vi } from "vitest";

import {
  type AgentId,
  type AuditRecordId,
  InvalidModerationReasonError,
  InvalidModerationTransitionError,
  isModerationReasonCategory,
  MODERATION_REASON_CATEGORIES,
  REPORT_REVIEW_DECISIONS,
  isReportReviewDecision,
  type ModeratorId,
  type PublicItemId,
  type ReportId,
  SafetyDomain,
} from "./index.js";

const agentId = "agent-1" as AgentId;
const reporterId = "agent-2" as AgentId;
const moderatorId = "moderator-1" as ModeratorId;
const publicItemId = "post-1" as PublicItemId;
const firstTime = new Date("2026-11-01T02:00:00.000Z");
const secondTime = new Date("2026-11-01T02:01:00.000Z");

function setup(times: readonly Date[] = [firstTime, secondTime]) {
  let reportNumber = 0;
  let auditNumber = 0;
  let timeIndex = 0;
  const nextReportId = vi.fn(() => `report-${++reportNumber}` as ReportId);
  const nextAuditRecordId = vi.fn(
    () => `audit-${++auditNumber}` as AuditRecordId,
  );
  const now = vi.fn(() => times[timeIndex++] ?? secondTime);
  const domain = new SafetyDomain({ nextReportId, nextAuditRecordId, now });

  return { domain, nextReportId, nextAuditRecordId, now };
}

const moderationContext = {
  moderatorId,
  reasonCategory: "abuse" as const,
  internalNote: "  Repeated targeted threats.  ",
  correlationId: "request-1",
};

describe("moderation reasons and reports", () => {
  it("exposes the complete first-release reason set", () => {
    expect(MODERATION_REASON_CATEGORIES).toEqual([
      "spam",
      "impersonation",
      "abuse",
      "unsafe_link",
    ]);
    expect(isModerationReasonCategory("unsafe_link")).toBe(true);
    expect(isModerationReasonCategory("unsafe-link")).toBe(false);
    expect(REPORT_REVIEW_DECISIONS).toEqual([
      "dismissed",
      "agent_suspended",
      "content_hidden",
    ]);
    expect(isReportReviewDecision("agent_suspended")).toBe(true);
    expect(isReportReviewDecision("deleted")).toBe(false);
  });

  it("records an agent report with a deterministic ID and time", () => {
    const { domain, nextAuditRecordId } = setup([firstTime]);

    const report = domain.submitReport({
      reportingAgentId: reporterId,
      target: { type: "public_item", publicItemId },
      reasonCategory: "unsafe_link",
    });

    expect(report).toEqual({
      id: "report-1",
      reportingAgentId: reporterId,
      target: { type: "public_item", publicItemId },
      reasonCategory: "unsafe_link",
      reportedAt: firstTime.toISOString(),
      status: "open",
    });
    expect(domain.listInternalReports()).toEqual([report]);
    expect(nextAuditRecordId).not.toHaveBeenCalled();
  });

  it("rejects an unknown reason before it allocates a report", () => {
    const { domain, nextReportId, now } = setup();

    expect(() =>
      domain.submitReport({
        reportingAgentId: reporterId,
        target: { type: "agent_profile", agentId },
        reasonCategory: "other" as "spam",
      }),
    ).toThrow(InvalidModerationReasonError);
    expect(nextReportId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
});

describe("content moderation", () => {
  it("hides content and returns its audit record in the same result", () => {
    const { domain } = setup([firstTime]);

    const result = domain.hideContent({
      publicItemId,
      ...moderationContext,
    });

    expect(result.state).toEqual({
      publicItemId,
      visibility: "hidden",
      reasonCategory: "abuse",
      actionTime: firstTime.toISOString(),
    });
    expect(result.audit).toEqual({
      id: "audit-1",
      eventType: "content.hidden",
      moderatorId,
      subject: { type: "public_item", id: publicItemId },
      reasonCategory: "abuse",
      internalNote: "Repeated targeted threats.",
      previousState: "visible",
      resultingState: "hidden",
      occurredAt: firstTime.toISOString(),
      correlationId: "request-1",
    });
    expect(domain.listInternalAuditRecords()).toEqual([result.audit]);
  });

  it("keeps private fields out of the public content projection", () => {
    const { domain } = setup([firstTime]);
    domain.hideContent({ publicItemId, ...moderationContext });

    const publicState = domain.projectContentPublicState(publicItemId);

    expect(publicState).toEqual({
      publicItemId,
      visibility: "hidden",
      reasonCategory: "abuse",
      actionTime: firstTime.toISOString(),
    });
    expect(publicState).not.toHaveProperty("moderatorId");
    expect(publicState).not.toHaveProperty("internalNote");
    expect(publicState).not.toHaveProperty("correlationId");
  });

  it("restores hidden content and audits the transition", () => {
    const { domain } = setup([firstTime, secondTime]);
    domain.hideContent({ publicItemId, ...moderationContext });

    const result = domain.restoreContent({
      publicItemId,
      moderatorId,
      reasonCategory: "abuse",
      correlationId: "request-2",
    });

    expect(result.state).toEqual({ publicItemId, visibility: "visible" });
    expect(result.audit).toMatchObject({
      id: "audit-2",
      eventType: "content.restored",
      previousState: "hidden",
      resultingState: "visible",
      occurredAt: secondTime.toISOString(),
      correlationId: "request-2",
    });
    expect(domain.projectContentPublicState(publicItemId)).toEqual(
      result.state,
    );
  });

  it("rejects a duplicate transition without adding an audit record", () => {
    const { domain, nextAuditRecordId } = setup([firstTime]);
    domain.hideContent({ publicItemId, ...moderationContext });

    expect(() =>
      domain.hideContent({ publicItemId, ...moderationContext }),
    ).toThrow(InvalidModerationTransitionError);
    expect(nextAuditRecordId).toHaveBeenCalledTimes(1);
    expect(domain.listInternalAuditRecords()).toHaveLength(1);
  });
});

describe("agent suspension", () => {
  it("suspends an active agent and exposes only public moderation fields", () => {
    const { domain } = setup([firstTime]);

    const result = domain.suspendAgent({
      agentId,
      currentStatus: "active",
      ...moderationContext,
    });

    expect(result.audit).toMatchObject({
      id: "audit-1",
      eventType: "agent.suspended",
      subject: { type: "agent", id: agentId },
      previousState: "active",
      resultingState: "suspended",
    });
    expect(domain.projectAgentPublicState(agentId, "active")).toEqual({
      agentId,
      status: "suspended",
      reasonCategory: "abuse",
      actionTime: firstTime.toISOString(),
    });
    expect(
      domain.projectAgentPublicState(agentId, "active"),
    ).not.toHaveProperty("internalNote");
  });

  it("restores the operator state that existed before suspension", () => {
    const { domain } = setup([firstTime, secondTime]);
    domain.suspendAgent({
      agentId,
      currentStatus: "stopped",
      ...moderationContext,
    });

    const result = domain.restoreAgent({
      agentId,
      moderatorId,
      reasonCategory: "abuse",
      correlationId: "request-2",
    });

    expect(result.state).toEqual({ agentId, status: "stopped" });
    expect(result.audit).toMatchObject({
      id: "audit-2",
      eventType: "agent.restored",
      previousState: "suspended",
      resultingState: "stopped",
      occurredAt: secondTime.toISOString(),
    });
    expect(domain.projectAgentPublicState(agentId, "stopped")).toEqual(
      result.state,
    );
  });

  it("rejects restoration when the agent is not suspended", () => {
    const { domain, nextAuditRecordId, now } = setup();

    expect(() =>
      domain.restoreAgent({
        agentId,
        moderatorId,
        reasonCategory: "spam",
        correlationId: "request-3",
      }),
    ).toThrow(InvalidModerationTransitionError);
    expect(nextAuditRecordId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });
});
