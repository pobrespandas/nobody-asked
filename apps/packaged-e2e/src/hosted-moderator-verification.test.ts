import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  queueContainsOwnedReport,
  verifyHostedModerator,
  verifyModeratorAuditEvidence,
  type ModeratorVerificationReport,
} from "./hosted-moderator-verification.js";
afterEach(() => vi.unstubAllGlobals());
const input = {
  baseUrl: new URL("https://network.test/"),
  operatorId: "private-operator",
  operatorCookie: "__session=private-session",
  origin: "https://operator.test",
};
const report: ModeratorVerificationReport = {
  result: "pass",
  phase: "done",
  reporterId: "reporter",
  subjectId: "subject",
  reporterHandle: "reporter",
  subjectHandle: "subject",
  postId: "post",
  reporterPostId: "reporter-post",
  postReportId: "post-report",
  agentReportId: "agent-report",
  checks: [],
  cleanup: {
    reporter: "stopped",
    subject: "suspended_credentials_revoked",
    post: "retained_hidden",
  },
  unverified: ["moderator_restore_unimplemented"],
};
describe("scoped Moderator verification", () => {
  it("documents stopped and suspended denial on both Recovery operations", () => {
    const contract = JSON.parse(
      readFileSync(
        new URL("../../api/openapi/v1.json", import.meta.url),
        "utf8",
      ),
    );
    for (const path of [
      "/v1/agents/{agentId}/recovery-challenges",
      "/v1/agents/{agentId}/recovery-challenges/{challengeId}/complete",
    ])
      expect(contract.paths[path].post.responses["403"]).toEqual({
        $ref: "#/components/responses/AgentBlocked",
      });
  });

  it("matches only the exact owned report and target", () => {
    const queue = [
      {
        id: "unrelated",
        status: "open",
        target: { type: "public_item", id: "post" },
      },
      {
        id: "own",
        status: "open",
        target: { type: "agent_profile", id: "post" },
      },
    ];
    expect(queueContainsOwnedReport(queue, "own", "public_item", "post")).toBe(
      false,
    );
    expect(
      queueContainsOwnedReport(
        [
          ...queue,
          {
            id: "own",
            status: "open",
            target: { type: "public_item", id: "post" },
          },
        ],
        "own",
        "public_item",
        "post",
      ),
    ).toBe(true);
    expect(
      queueContainsOwnedReport(
        [
          {
            id: "own",
            status: "resolved",
            target: { type: "public_item", id: "post" },
          },
        ],
        "own",
        "public_item",
        "post",
      ),
    ).toBe(false);
  });
  it("rejects unsafe session input before network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      verifyHostedModerator({
        ...input,
        operatorCookie: "__session=private\r\nsecret",
      }),
    ).rejects.toThrow(/^Invalid Moderator verification input\.$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("stops before registration if Moderator authority is absent and sanitizes its report", async () => {
    const paths = {
      "/v1/me": {
        get: { operationId: "getAuthenticatedAgent", tags: ["Agent reads"] },
      },
      "/v1/moderator/reports": {
        get: { operationId: "listOpenReports", tags: ["Moderation"] },
      },
    };
    const fetch = vi.fn(async (url: URL) =>
      url.pathname === "/v1"
        ? Response.json({ contract: { href: "/v1/openapi.json" } })
        : url.pathname === "/v1/openapi.json"
          ? Response.json({ paths })
          : Response.json(
              {
                error: {
                  code: "moderator_authority_denied",
                  message: "private identity",
                },
              },
              { status: 403 },
            ),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await verifyHostedModerator(input);
    expect(result).toMatchObject({
      result: "fail",
      phase: "moderator_preflight",
      reporterId: null,
      subjectId: null,
      cleanup: { reporter: "not-created", subject: "not-created" },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toMatch(
      /private identity|private-session|private-operator/,
    );
  });
  it("verifies four attributed audit records without returning private fields", async () => {
    const actions: Record<string, string> = {
      post: "content.hidden",
      "post-report": "report.resolved",
      subject: "agent.suspended",
      "agent-report": "report.resolved",
    };
    const result = await verifyModeratorAuditEvidence({
      operatorId: input.operatorId,
      report,
      readSubjectAudits: async (id) => [
        {
          subjectId: id,
          action: actions[id],
          actorType: "moderator",
          actorId: input.operatorId,
          details: {
            reasonCategory: "spam",
            result: "completed",
            correlationId: id.startsWith("post")
              ? "post-correlation"
              : "agent-correlation",
            internalNote: "private internal note",
          },
        },
      ],
    });
    expect(result).toMatchObject({ result: "pass", verifiedRecords: 4 });
    expect(JSON.stringify(result)).not.toMatch(
      /private-operator|private internal note|correlationId/,
    );
  });
  it("rejects mismatched audit actors and correlations", async () => {
    const result = await verifyModeratorAuditEvidence({
      operatorId: input.operatorId,
      report,
      readSubjectAudits: async (id) => [
        {
          subjectId: id,
          action: "content.hidden",
          actorType: "moderator",
          actorId: "another-private-operator",
          details: {
            reasonCategory: "spam",
            result: "completed",
            correlationId: "private-correlation",
          },
        },
      ],
    });
    expect(result).toEqual({ result: "fail", verifiedRecords: 0, checks: [] });
  });
});
