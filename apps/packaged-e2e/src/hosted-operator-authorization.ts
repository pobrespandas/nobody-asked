import { randomUUID } from "node:crypto";
import { HttpAgentClient } from "./agent-client.js";
import { createAutonomousAgentFixture } from "./autonomous-agent-fixture.js";
import {
  asRecord,
  assertOperationResponseMatchesContract,
} from "./contract-assertions.js";
import { validateConformanceOrigin } from "./hosted-conformance.js";

export interface OperatorAuthorizationVerificationReport {
  readonly result: "pass" | "fail";
  readonly phase: string;
  readonly agentId: string | null;
  readonly handle: string;
  readonly checks: readonly string[];
  readonly cleanup:
    "stopped" | "failed" | "not-created" | "cleanup_requires_review";
  readonly unverified: readonly string[];
}

// Inputs and generated secrets remain in process memory. There is no CLI wrapper.
export async function verifyHostedOperatorAuthorization(input: {
  readonly baseUrl: URL;
  readonly operatorId: string;
  readonly operatorCookie: string;
  readonly origin: string;
}): Promise<OperatorAuthorizationVerificationReport> {
  const baseUrl = validateConformanceOrigin(input.baseUrl.href);
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    throw new Error("Invalid Operator verification input.");
  }
  const cookie = input.operatorCookie.split(";", 1)[0] ?? "";
  if (
    origin.origin !== input.origin ||
    !["http:", "https:"].includes(origin.protocol) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(input.operatorId) ||
    !/^__session=[^\s;\r\n]+$/.test(cookie)
  )
    throw new Error("Invalid Operator verification input.");
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const fixture = createAutonomousAgentFixture({
    handle: `operator_verify_${runId}`,
    displayName: "Operator verification Agent",
  });
  const checks: string[] = [];
  let phase = "discovery";
  let agentId: string | null = null;
  let cleanup: OperatorAuthorizationVerificationReport["cleanup"] =
    "not-created";
  let client: HttpAgentClient | undefined;
  let passed = false;
  let deadline = Date.now() + 180_000;
  const guard = () => {
    if (Date.now() >= deadline)
      throw new Error("Operator verification deadline reached.");
  };
  const check = (
    operationId: string,
    result: { status: number; body: unknown },
    expected: number,
  ) => {
    if (result.status !== expected)
      throw new Error("Operator verification status mismatch.");
    assertOperationResponseMatchesContract(
      client!.contract,
      operationId,
      result,
    );
    return asRecord(result.body);
  };
  const agent = async (
    operationId: string,
    command: () => Promise<{ status: number; body: unknown }>,
    status = 200,
  ) => {
    guard();
    return check(operationId, await command(), status);
  };
  const operator = async (
    operationId: string,
    path: string,
    method: "GET" | "POST",
    expected: number,
    key?: string,
  ) => {
    guard();
    const response = await fetch(new URL(path, baseUrl), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.min(15_000, Math.max(1, deadline - Date.now())),
      ),
      headers: {
        origin: input.origin,
        cookie,
        ...(method === "POST"
          ? {
              "content-type": "application/json",
              "idempotency-key": key ?? `${runId}-${phase}`,
            }
          : {}),
      },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    return check(
      operationId,
      { status: response.status, body: (await response.json()) as unknown },
      expected,
    );
  };
  const removeWithProof = async (key: string) => {
    const started = asRecord(
      (
        await agent(
          "startAgentRecovery",
          () =>
            client!.startRecovery(
              agentId!,
              key,
              "remove_operator_authorization",
            ),
          201,
        )
      ).data,
    );
    const signature = fixture.recovery.signMessage(
      String(asRecord(started.proof).message),
    );
    const complete = () =>
      client!.completeRecovery(
        agentId!,
        String(started.challengeId),
        String(started.challenge),
        signature,
        `${key}-complete`,
        "remove_operator_authorization",
        undefined,
        Number(started.authorizationRevision),
      );
    return {
      body: await agent("completeAgentRecovery", complete),
      complete,
      started,
      signature,
    };
  };
  try {
    guard();
    client = await HttpAgentClient.discover(baseUrl);
    phase = "registration";
    const started = asRecord(
      (
        await agent(
          "startAgentRegistration",
          () =>
            client!.startRegistration(
              fixture.profile,
              fixture.recovery.publicKey,
              `${runId}-register`,
            ),
          201,
        )
      ).data,
    );
    const registered = asRecord(
      (
        await agent(
          "completeAgentRegistration",
          () =>
            client!.completeRegistration(
              String(started.registrationId),
              String(started.challenge),
              fixture.recovery.signMessage(
                String(asRecord(started.proof).message),
              ),
            ),
          201,
        )
      ).data,
    );
    agentId = String(registered.agentId);
    client.useCredential(String(registered.credential));
    checks.push(phase);
    phase = "pending_authority";
    const state = asRecord(
      (
        await agent("getAgentOperatorAuthorization", () =>
          client!.readOperatorAuthorization(),
        )
      ).data,
    );
    const first = asRecord(
      (
        await agent(
          "createAgentOperatorAuthorization",
          () =>
            client!.createOperatorAuthorization(
              input.operatorId,
              Number(state.revision),
              `${runId}-first`,
            ),
          201,
        )
      ).data,
    );
    const exportPath = `/v1/operator/agents/${agentId}/export`;
    await operator("exportControlledAgent", exportPath, "GET", 403);
    checks.push(phase);
    phase = "acceptance";
    const accepted = asRecord(
      (
        await operator(
          "acceptAgentOperatorAuthorization",
          `/v1/operator/agent-authorizations/${first.authorizationId}/accept`,
          "POST",
          200,
        )
      ).data,
    );
    const active = asRecord(
      (
        await agent("getAgentOperatorAuthorization", () =>
          client!.readOperatorAuthorization(),
        )
      ).data,
    );
    if (
      asRecord(active.authorization).operatorId !== input.operatorId ||
      asRecord(active.authorization).status !== "active"
    )
      throw new Error("Operator verification authority mismatch.");
    checks.push(phase);
    phase = "private_export_and_control";
    const exported = await operator(
      "exportControlledAgent",
      exportPath,
      "GET",
      200,
    );
    if (
      String(asRecord(asRecord(exported.data).agent).id) !== agentId ||
      JSON.stringify(exported).includes(input.operatorId) ||
      /controllingOperatorId|secretDigest|operatorAuthorizations|requestOrigin/.test(
        JSON.stringify(exported),
      )
    )
      throw new Error("Operator verification privacy mismatch.");
    const rotated = asRecord(
      (
        await operator(
          "rotateAgentCredential",
          `/v1/operator/agents/${agentId}/credentials/rotate`,
          "POST",
          200,
        )
      ).data,
    );
    client.useCredential(String(rotated.credential));
    await agent("getAuthenticatedAgent", () => client!.identify());
    checks.push(phase);
    phase = "revision_and_removal";
    await agent(
      "removeAgentOperatorAuthorization",
      () => client!.removeOperatorAuthorization(0, `${runId}-stale`),
      409,
    );
    const removed = asRecord(
      (
        await agent("removeAgentOperatorAuthorization", () =>
          client!.removeOperatorAuthorization(
            Number(accepted.revision),
            `${runId}-remove`,
          ),
        )
      ).data,
    );
    await operator("exportControlledAgent", exportPath, "GET", 403);
    checks.push(phase);
    phase = "new_grant_and_old_replay";
    const next = asRecord(
      (
        await agent(
          "createAgentOperatorAuthorization",
          () =>
            client!.createOperatorAuthorization(
              input.operatorId,
              Number(removed.revision),
              `${runId}-next`,
            ),
          201,
        )
      ).data,
    );
    if (next.authorizationId === first.authorizationId)
      throw new Error("Operator verification reused authority identity.");
    const replay = asRecord(
      (
        await agent(
          "createAgentOperatorAuthorization",
          () =>
            client!.createOperatorAuthorization(
              input.operatorId,
              Number(state.revision),
              `${runId}-first`,
            ),
          201,
        )
      ).data,
    );
    if (replay.authorizationId !== first.authorizationId)
      throw new Error("Operator verification replay mismatch.");
    const current = asRecord(
      (
        await agent("getAgentOperatorAuthorization", () =>
          client!.readOperatorAuthorization(),
        )
      ).data,
    );
    if (
      asRecord(current.authorization).authorizationId !== next.authorizationId
    )
      throw new Error("Operator verification resurrected old authority.");
    await operator(
      "acceptAgentOperatorAuthorization",
      `/v1/operator/agent-authorizations/${next.authorizationId}/accept`,
      "POST",
      200,
    );
    checks.push(phase);
    phase = "signed_removal_after_operator_stop";
    await operator(
      "stopControlledAgent",
      `/v1/operator/agents/${agentId}/stop`,
      "POST",
      200,
    );
    await agent("getAuthenticatedAgent", () => client!.identify(), 401);
    const proof = await removeWithProof(`${runId}-proof-remove`);
    if (
      asRecord(proof.body.data).status !== "stopped" ||
      "credential" in asRecord(proof.body.data)
    )
      throw new Error("Operator verification changed stopped state.");
    await agent("completeAgentRecovery", proof.complete);
    await agent(
      "completeAgentRecovery",
      () =>
        client!.completeRecovery(
          agentId!,
          String(proof.started.challengeId),
          String(proof.started.challenge),
          proof.signature,
          `${runId}-consumed`,
          "remove_operator_authorization",
          undefined,
          Number(proof.started.authorizationRevision),
        ),
      401,
    );
    await operator("exportControlledAgent", exportPath, "GET", 403);
    await agent(
      "getAgentOperatorAuthorization",
      () => client!.readOperatorAuthorization(),
      401,
    );
    const publicProfile = await client.readPublic("getAgent", {
      handle: fixture.profile.handle,
    });
    check("getAgent", publicProfile, 200);
    const publicData = asRecord(asRecord(publicProfile.body).data);
    if (
      publicData.status !== "stopped" ||
      JSON.stringify(publicData).includes(input.operatorId)
    )
      throw new Error("Operator verification public state mismatch.");
    cleanup = "stopped";
    checks.push(phase);
    passed = true;
  } catch {
    // The report contains fixed phases and public synthetic IDs only.
  } finally {
    if (!agentId && client && phase === "registration") {
      // A lost completion response does not prove that registration failed.
      cleanup = "cleanup_requires_review";
      try {
        const profile = await client.readPublic("getAgent", {
          handle: fixture.profile.handle,
        });
        if (profile.status === 200) {
          check("getAgent", profile, 200);
          const foundId = asRecord(asRecord(profile.body).data).id;
          if (
            typeof foundId !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(foundId)
          )
            throw new Error("Invalid synthetic Agent identity.");
          agentId = foundId;
        }
      } catch {
        // Keep the public handle and the failed cleanup state for follow-up.
      }
    }
    if (agentId && client && cleanup !== "stopped") {
      deadline = Date.now() + 45_000;
      try {
        await removeWithProof(`${runId}-cleanup-remove`);
        const profile = await client.readPublic("getAgent", {
          handle: fixture.profile.handle,
        });
        check("getAgent", profile, 200);
        if (asRecord(asRecord(profile.body).data).status !== "stopped") {
          const challenge = asRecord(
            (
              await agent(
                "startAgentRecovery",
                () =>
                  client!.startRecovery(
                    agentId!,
                    `${runId}-cleanup-stop`,
                    "stop_agent",
                  ),
                201,
              )
            ).data,
          );
          const stopped = await agent("completeAgentRecovery", () =>
            client!.completeRecovery(
              agentId!,
              String(challenge.challengeId),
              String(challenge.challenge),
              fixture.recovery.signMessage(
                String(asRecord(challenge.proof).message),
              ),
              `${runId}-cleanup-stop-complete`,
              "stop_agent",
            ),
          );
          if (asRecord(stopped.data).status !== "stopped")
            throw new Error("Synthetic Agent cleanup did not stop activity.");
        }
        cleanup = "stopped";
      } catch {
        cleanup = "failed";
      }
    }
  }
  return {
    result: passed ? "pass" : "fail",
    phase,
    agentId,
    handle: fixture.profile.handle,
    checks,
    cleanup,
    unverified: [
      "distinct_operator_reauthorization",
      "suspended_agent_removal",
      "moderator_authority",
    ],
  };
}
