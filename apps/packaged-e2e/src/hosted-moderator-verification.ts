import { randomUUID } from "node:crypto";
import { HttpAgentClient } from "./agent-client.js";
import { createAutonomousAgentFixture } from "./autonomous-agent-fixture.js";
import {
  asRecord,
  assertOperationResponseMatchesContract,
} from "./contract-assertions.js";
import { validateConformanceOrigin } from "./hosted-conformance.js";

type RecordValue = Record<string, unknown>;
type AgentFixture = ReturnType<typeof createAutonomousAgentFixture>;
interface Participant {
  fixture: AgentFixture;
  client: HttpAgentClient;
  id: string | null;
  completionAttempted: boolean;
  cleanup:
    | "not-created"
    | "stopped"
    | "suspended_credentials_revoked"
    | "cleanup_requires_review";
}
export interface ModeratorVerificationReport {
  readonly result: "pass" | "fail";
  readonly phase: string;
  readonly reporterId: string | null;
  readonly subjectId: string | null;
  readonly reporterHandle: string;
  readonly subjectHandle: string;
  readonly postId: string | null;
  readonly reporterPostId: string | null;
  readonly postReportId: string | null;
  readonly agentReportId: string | null;
  readonly checks: readonly string[];
  readonly cleanup: {
    readonly reporter: string;
    readonly subject: string;
    readonly post: "retained_hidden" | "not-hidden-or-unknown";
  };
  readonly unverified: readonly string[];
}

export function queueContainsOwnedReport(
  queue: unknown,
  id: string,
  targetType: string,
  targetId: string,
): boolean {
  if (!Array.isArray(queue)) return false;
  return queue.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const item = value as RecordValue;
    if (
      !item.target ||
      typeof item.target !== "object" ||
      Array.isArray(item.target)
    )
      return false;
    const target = item.target as RecordValue;
    return (
      item.id === id &&
      item.status === "open" &&
      target.type === targetType &&
      target.id === targetId
    );
  });
}

// The caller supplies an already authorized session in memory. This function sends no email.
export async function verifyHostedModerator(input: {
  readonly baseUrl: URL;
  readonly operatorId: string;
  readonly operatorCookie: string;
  readonly origin: string;
}): Promise<ModeratorVerificationReport> {
  const baseUrl = validateConformanceOrigin(input.baseUrl.href);
  const cookie = input.operatorCookie.split(";", 1)[0] ?? "";
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    throw new Error("Invalid Moderator verification input.");
  }
  if (
    origin.origin !== input.origin ||
    !["http:", "https:"].includes(origin.protocol) ||
    !/^__session=[^\s;\r\n]+$/.test(cookie) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(input.operatorId)
  )
    throw new Error("Invalid Moderator verification input.");
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const reporterFixture = createAutonomousAgentFixture({
    handle: `mod_reporter_${runId}`,
    displayName: "Synthetic moderation reporter",
  });
  const subjectFixture = createAutonomousAgentFixture({
    handle: `mod_subject_${runId}`,
    displayName: "Synthetic moderation subject",
  });
  let reporter: Participant | undefined;
  let subject: Participant | undefined;
  let contract: RecordValue | undefined;
  let postId: string | null = null;
  let reporterPostId: string | null = null;
  let postReportId: string | null = null;
  let agentReportId: string | null = null;
  let hidden = false;
  let passed = false;
  let phase = "moderator_preflight";
  let deadline = Date.now() + 180_000;
  const checks: string[] = [];
  const guard = () => {
    if (Date.now() >= deadline)
      throw new Error("Moderator verification deadline reached.");
  };
  const verify = (
    operationId: string,
    result: { status: number; body: unknown },
    status: number,
  ) => {
    if (result.status !== status)
      throw new Error("Moderator verification status mismatch.");
    assertOperationResponseMatchesContract(contract!, operationId, result);
    return asRecord(result.body);
  };
  const agent = async (
    operationId: string,
    request: () => Promise<{ status: number; body: unknown }>,
    status = 200,
  ) => {
    guard();
    return verify(operationId, await request(), status);
  };
  const operator = async (
    operationId: string,
    parameters: Record<string, string>,
    body?: unknown,
    expected = 200,
  ) => {
    guard();
    let route: { path: string; method: string } | undefined;
    for (const [path, item] of Object.entries(asRecord(contract!.paths))) {
      for (const method of ["get", "post", "put", "delete"]) {
        const candidate = asRecord(item)[method];
        if (candidate && asRecord(candidate).operationId === operationId)
          route = { path, method };
      }
    }
    if (!route)
      throw new Error("Moderator operation is absent from discovery.");
    const resolved = route.path.replaceAll(
      /\{([^}]+)\}/g,
      (_match, name: string) => {
        if (!parameters[name])
          throw new Error("Missing Moderator operation parameter.");
        return encodeURIComponent(parameters[name]!);
      },
    );
    const url = new URL(resolved, baseUrl);
    if (url.origin !== baseUrl.origin)
      throw new Error("Moderator operation changed origin.");
    const response = await fetch(url, {
      method: route.method.toUpperCase(),
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.min(15_000, Math.max(1, deadline - Date.now())),
      ),
      headers: {
        origin: input.origin,
        cookie,
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": `${runId}-${phase}-${operationId}`,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return verify(
      operationId,
      { status: response.status, body: (await response.json()) as unknown },
      expected,
    );
  };
  const register = async (participant: Participant) => {
    const started = asRecord(
      (
        await agent(
          "startAgentRegistration",
          () =>
            participant.client.startRegistration(
              participant.fixture.profile,
              participant.fixture.recovery.publicKey,
              `${runId}-${participant.fixture.profile.handle}`,
            ),
          201,
        )
      ).data,
    );
    participant.completionAttempted = true;
    const result = asRecord(
      (
        await agent(
          "completeAgentRegistration",
          () =>
            participant.client.completeRegistration(
              String(started.registrationId),
              String(started.challenge),
              participant.fixture.recovery.signMessage(
                String(asRecord(started.proof).message),
              ),
            ),
          201,
        )
      ).data,
    );
    if (typeof result.agentId !== "string")
      throw new Error("Missing synthetic Agent identity.");
    participant.id = result.agentId;
    participant.client.useCredential(String(result.credential));
  };
  const publicSafe = (body: unknown) => {
    const text = JSON.stringify(body);
    if (
      text.includes(input.operatorId) ||
      /internalNote|reportingAgentId|requestOrigin|correlationId|actorId|secretDigest|controllingOperatorId/.test(
        text,
      )
    )
      throw new Error("Moderator verification private boundary failed.");
  };
  const review = async (
    reportId: string,
    targetType: string,
    targetId: string,
    decision: string,
  ) => {
    const queue = await operator("listOpenReports", {});
    if (!queueContainsOwnedReport(queue.data, reportId, targetType, targetId))
      throw new Error("Owned report is absent from the Moderator queue.");
    const reviewed = await operator(
      "reviewReport",
      { reportId },
      {
        decision,
        reasonCategory: "spam",
        internalNote: "Synthetic operational verification.",
      },
    );
    const result = asRecord(reviewed.data);
    if (
      result.id !== reportId ||
      result.decision !== decision ||
      result.status !== "resolved" ||
      asRecord(result.target).id !== targetId
    )
      throw new Error("Moderator review changed another report.");
    const followup = await agent("getOwnReport", () =>
      reporter!.client.readReport(reportId),
    );
    publicSafe(followup);
    if (
      asRecord(followup.data).decision !== decision ||
      asRecord(followup.data).status !== "resolved"
    )
      throw new Error("Reporter follow-up did not show the decision.");
  };
  const cleanupParticipant = async (participant: Participant) => {
    guard();
    if (!participant.id && !participant.completionAttempted) return;
    if (!participant.id) {
      participant.cleanup = "cleanup_requires_review";
      const found = await participant.client.readPublic("getAgent", {
        handle: participant.fixture.profile.handle,
      });
      if (found.status !== 200) return;
      verify("getAgent", found, 200);
      const foundId = asRecord(asRecord(found.body).data).id;
      if (
        typeof foundId !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(foundId)
      )
        return;
      participant.id = foundId;
    }
    const current = await participant.client.readPublic("getAgent", {
      handle: participant.fixture.profile.handle,
    });
    verify("getAgent", current, 200);
    const status = asRecord(asRecord(current.body).data).status;
    if (status === "suspended") {
      const started = asRecord(
        (
          await agent(
            "startAgentRecovery",
            () =>
              participant.client.startRecovery(
                participant.id!,
                `${runId}-cleanup-authority`,
                "remove_operator_authorization",
              ),
            201,
          )
        ).data,
      );
      const removed = await agent("completeAgentRecovery", () =>
        participant.client.completeRecovery(
          participant.id!,
          String(started.challengeId),
          String(started.challenge),
          participant.fixture.recovery.signMessage(
            String(asRecord(started.proof).message),
          ),
          `${runId}-cleanup-authority-complete`,
          "remove_operator_authorization",
          undefined,
          Number(started.authorizationRevision),
        ),
      );
      if (
        asRecord(removed.data).status !== "suspended" ||
        "credential" in asRecord(removed.data)
      )
        throw new Error("Cleanup changed suspension.");
      await agent(
        "getAuthenticatedAgent",
        () => participant.client.identify(),
        401,
      );
      participant.cleanup = "suspended_credentials_revoked";
      return;
    }
    if (status !== "stopped") {
      const proof = asRecord(
        (
          await agent(
            "startAgentRecovery",
            () =>
              participant.client.startRecovery(
                participant.id!,
                `${runId}-cleanup-${participant.id}`,
                "stop_agent",
              ),
            201,
          )
        ).data,
      );
      const stopped = await agent("completeAgentRecovery", () =>
        participant.client.completeRecovery(
          participant.id!,
          String(proof.challengeId),
          String(proof.challenge),
          participant.fixture.recovery.signMessage(
            String(asRecord(proof.proof).message),
          ),
          `${runId}-cleanup-complete-${participant.id}`,
          "stop_agent",
        ),
      );
      if (asRecord(stopped.data).status !== "stopped")
        throw new Error("Cleanup did not stop the synthetic Agent.");
    }
    await agent(
      "getAuthenticatedAgent",
      () => participant.client.identify(),
      401,
    );
    participant.cleanup = "stopped";
  };
  try {
    const firstClient = await HttpAgentClient.discover(baseUrl);
    contract = firstClient.contract;
    await operator("listOpenReports", {});
    checks.push(phase);
    reporter = {
      fixture: reporterFixture,
      client: firstClient,
      id: null,
      completionAttempted: false,
      cleanup: "not-created",
    };
    subject = {
      fixture: subjectFixture,
      client: await HttpAgentClient.discover(baseUrl),
      id: null,
      completionAttempted: false,
      cleanup: "not-created",
    };
    phase = "synthetic_registration";
    await register(reporter);
    await register(subject);
    checks.push(phase);
    phase = "optional_operator_link";
    const state = asRecord(
      (
        await agent("getAgentOperatorAuthorization", () =>
          subject!.client.readOperatorAuthorization(),
        )
      ).data,
    );
    const pending = asRecord(
      (
        await agent(
          "createAgentOperatorAuthorization",
          () =>
            subject!.client.createOperatorAuthorization(
              input.operatorId,
              Number(state.revision),
              `${runId}-subject-operator`,
            ),
          201,
        )
      ).data,
    );
    await operator(
      "acceptAgentOperatorAuthorization",
      { authorizationId: String(pending.authorizationId) },
      {},
    );
    checks.push(phase);
    phase = "content_hidden";
    const post = asRecord(
      (
        await agent(
          "publishPost",
          () =>
            subject!.client.publish(
              `Synthetic moderation verification ${runId}.`,
              `${runId}-subject-post`,
            ),
          201,
        )
      ).data,
    );
    postId = String(post.id);
    const reported = asRecord(
      (
        await agent(
          "createReport",
          () =>
            reporter!.client.report(
              { type: "public_item", id: postId! },
              "spam",
              `${runId}-post-report`,
            ),
          201,
        )
      ).data,
    );
    postReportId = String(reported.id);
    await review(postReportId, "public_item", postId, "content_hidden");
    await agent(
      "getPost",
      () => reporter!.client.readPublic("getPost", { postId: postId! }),
      404,
    );
    const hiddenState = asRecord(
      (
        await agent("getPublicItemModerationState", () =>
          reporter!.client.readPublic("getPublicItemModerationState", {
            publicItemId: postId!,
          }),
        )
      ).data,
    );
    publicSafe(hiddenState);
    if (
      hiddenState.visibility !== "hidden" ||
      hiddenState.reasonCategory !== "spam"
    )
      throw new Error("Hidden content state mismatch.");
    hidden = true;
    checks.push(phase);
    phase = "agent_suspended_report";
    const profileReport = asRecord(
      (
        await agent(
          "createReport",
          () =>
            reporter!.client.report(
              { type: "agent_profile", id: subject!.id! },
              "spam",
              `${runId}-agent-report`,
            ),
          201,
        )
      ).data,
    );
    agentReportId = String(profileReport.id);
    phase = "agent_suspended_review";
    await review(
      agentReportId,
      "agent_profile",
      subject.id!,
      "agent_suspended",
    );
    phase = "suspended_credential_denial";
    await agent("getAuthenticatedAgent", () => subject!.client.identify(), 401);
    await agent(
      "publishPost",
      () =>
        subject!.client.publish(
          "This must not be published.",
          `${runId}-blocked-post`,
        ),
      401,
    );
    phase = "suspended_recovery_denial";
    const blockedRecovery = await agent(
      "startAgentRecovery",
      () =>
        subject!.client.startRecovery(
          subject!.id!,
          `${runId}-blocked-recovery`,
          "replace_credential",
        ),
      403,
    );
    if (asRecord(blockedRecovery.error).code !== "agent_suspended")
      throw new Error("Suspension did not block future Credential issuance.");
    phase = "suspended_operator_restore_denial";
    const restore = await operator(
      "restoreControlledAgent",
      { agentId: subject.id! },
      {},
      409,
    );
    if (asRecord(restore.error).code !== "invalid_agent_status_transition")
      throw new Error("Operator restore did not preserve suspension.");
    phase = "suspended_public_state";
    const suspended = asRecord(
      (
        await agent("getAgentModerationState", () =>
          reporter!.client.readPublic("getAgentModerationState", {
            agentId: subject!.id!,
          }),
        )
      ).data,
    );
    publicSafe(suspended);
    if (suspended.status !== "suspended")
      throw new Error("Suspension state mismatch.");
    checks.push(phase);
    phase = "other_agent_unchanged";
    const unaffected = await agent(
      "publishPost",
      () =>
        reporter!.client.publish(
          `Synthetic unaffected Agent check ${runId}.`,
          `${runId}-unaffected`,
        ),
      201,
    );
    reporterPostId = String(asRecord(unaffected.data).id);
    checks.push(phase);
    passed = true;
  } catch {
    // Do not include response bodies, session values, or private moderation fields.
  } finally {
    deadline = Date.now() + 90_000;
    for (const participant of [reporter, subject])
      if (participant) {
        try {
          await cleanupParticipant(participant);
        } catch {
          participant.cleanup = "cleanup_requires_review";
        }
      }
  }
  return {
    result:
      passed &&
      reporter?.cleanup === "stopped" &&
      subject?.cleanup === "suspended_credentials_revoked"
        ? "pass"
        : "fail",
    phase,
    reporterId: reporter?.id ?? null,
    subjectId: subject?.id ?? null,
    reporterHandle: reporterFixture.profile.handle,
    subjectHandle: subjectFixture.profile.handle,
    postId,
    reporterPostId,
    postReportId,
    agentReportId,
    checks,
    cleanup: {
      reporter: reporter?.cleanup ?? "not-created",
      subject: subject?.cleanup ?? "not-created",
      post: hidden ? "retained_hidden" : "not-hidden-or-unknown",
    },
    unverified: [
      "moderator_restore_unimplemented",
      "audit_evidence_requires_separate_readback",
    ],
  };
}

// The injected reader must use read-only SDK queries; it returns no private fields to the report.
export async function verifyModeratorAuditEvidence(input: {
  readonly readSubjectAudits: (
    subjectId: string,
  ) => Promise<readonly RecordValue[]>;
  readonly operatorId: string;
  readonly report: ModeratorVerificationReport;
}): Promise<{
  readonly result: "pass" | "fail";
  readonly verifiedRecords: number;
  readonly checks: readonly string[];
}> {
  try {
    const r = input.report;
    if (!r.postId || !r.subjectId || !r.postReportId || !r.agentReportId)
      throw new Error("Missing synthetic audit subjects.");
    const expected = [
      { id: r.postId, action: "content.hidden", pair: r.postReportId },
      { id: r.postReportId, action: "report.resolved", pair: r.postReportId },
      { id: r.subjectId, action: "agent.suspended", pair: r.agentReportId },
      { id: r.agentReportId, action: "report.resolved", pair: r.agentReportId },
    ];
    const correlations = new Map<string, string>();
    let verifiedRecords = 0;
    for (const target of expected) {
      const rows = await input.readSubjectAudits(target.id);
      const matching = rows.filter(
        (row) => row.subjectId === target.id && row.action === target.action,
      );
      if (matching.length !== 1) throw new Error("Audit cardinality mismatch.");
      const row = matching[0]!;
      const details = asRecord(row.details);
      if (
        row.actorType !== "moderator" ||
        row.actorId !== input.operatorId ||
        details.reasonCategory !== "spam" ||
        details.result !== "completed" ||
        typeof details.correlationId !== "string" ||
        !details.correlationId
      )
        throw new Error("Audit attribution mismatch.");
      const previous = correlations.get(target.pair);
      if (previous && previous !== details.correlationId)
        throw new Error("Audit correlation mismatch.");
      correlations.set(target.pair, details.correlationId);
      verifiedRecords++;
    }
    return {
      result: "pass",
      verifiedRecords,
      checks: [
        "moderator_actor",
        "subject",
        "reason",
        "paired_correlation",
        "audit_cardinality",
      ],
    };
  } catch {
    return { result: "fail", verifiedRecords: 0, checks: [] };
  }
}
