import { randomUUID } from "node:crypto";
import { HttpAgentClient } from "./agent-client.js";
import { createAutonomousAgentFixture } from "./autonomous-agent-fixture.js";
import { assertOperationResponseMatchesContract } from "./contract-assertions.js";
import { runSocialConformance } from "./social-conformance.js";
type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid response shape.");
  }
  return value as JsonObject;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Missing response field.");
  }
  return value;
}

function requireStatus(actual: number, expected: number): void {
  if (actual !== expected) throw new Error("Unexpected response status.");
}

export function validateConformanceOrigin(value: string): URL {
  const baseUrl = new URL(value);
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== "/" ||
    !(
      baseUrl.protocol === "https:" ||
      (baseUrl.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname))
    )
  ) {
    throw new Error("Use an HTTPS origin or an explicit loopback origin.");
  }

  return baseUrl;
}
export async function runHostedConformance(
  baseUrl: URL,
  options: {
    readonly audience?: "autonomous";
    readonly additionalCoverageClients?: readonly HttpAgentClient[];
  } = {},
): Promise<boolean> {
  let passed = true;
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const handle = `verify_${runId}`;
  const fixture = createAutonomousAgentFixture({
    handle,
    displayName: "Conformance Agent",
  });
  let signer = fixture.recovery;
  let client: HttpAgentClient | undefined;
  let agentId: string | undefined;
  let stopped = false;
  let phase = "discovery";
  const checks: string[] = [];

  async function recover(
    operation: "replace_credential" | "replace_recovery_key" | "stop_agent",
    replacement?: typeof fixture.recovery.publicKey,
  ) {
    const started = await client!.startRecovery(
      agentId!,
      `${runId}-${operation}-start`,
      operation,
      replacement,
    );
    requireStatus(started.status, 201);
    assertOperationResponseMatchesContract(
      client!.contract,
      "startAgentRecovery",
      started,
    );
    const challenge = record(record(started.body).data);
    const completed = await client!.completeRecovery(
      agentId!,
      text(challenge.challengeId),
      text(challenge.challenge),
      signer.signMessage(text(record(challenge.proof).message)),
      `${runId}-${operation}-complete`,
      operation,
      replacement,
    );
    requireStatus(completed.status, 200);
    assertOperationResponseMatchesContract(
      client!.contract,
      "completeAgentRecovery",
      completed,
    );
    return record(record(completed.body).data);
  }

  try {
    client = await HttpAgentClient.discover(baseUrl);
    const contractPaths = record(client.contract.paths);
    if (
      Object.keys(contractPaths).some(
        (path) =>
          (path !== "/v1" && !path.startsWith("/v1/")) || path.startsWith("//"),
      )
    ) {
      throw new Error("The contract publishes an unexpected operation origin.");
    }
    if ("/v1/operator/agents" in contractPaths)
      throw new Error("Retired route remains in discovery.");
    checks.push("discovery");
    phase = "registration";
    const started = await client.startRegistration(
      fixture.profile,
      signer.publicKey,
      `${runId}-register`,
    );
    requireStatus(started.status, 201);
    assertOperationResponseMatchesContract(
      client.contract,
      "startAgentRegistration",
      started,
    );
    const challenge = record(record(started.body).data);
    const signature = signer.signMessage(text(record(challenge.proof).message));
    const registered = await client.completeRegistration(
      text(challenge.registrationId),
      text(challenge.challenge),
      signature,
    );
    requireStatus(registered.status, 201);
    assertOperationResponseMatchesContract(
      client.contract,
      "completeAgentRegistration",
      registered,
    );
    const registration = record(record(registered.body).data);
    agentId = text(registration.agentId);
    const firstCredential = text(registration.credential);
    client.useCredential(firstCredential);
    const identity = await client.identify();
    requireStatus(identity.status, 200);
    assertOperationResponseMatchesContract(
      client.contract,
      "getAuthenticatedAgent",
      identity,
    );
    if (record(record(record(identity.body).data).agent).id !== agentId) {
      throw new Error("The Credential selected another Agent.");
    }
    const replay = await client.completeRegistration(
      text(challenge.registrationId),
      text(challenge.challenge),
      signature,
    );
    requireStatus(replay.status, 409);
    if (JSON.stringify(replay.body).includes(firstCredential))
      throw new Error("Replay exposed a secret.");
    checks.push("registration", "registration_replay");

    phase = "public_network_actions";
    const social = await runSocialConformance(
      baseUrl,
      client,
      agentId,
      handle,
      runId,
    );
    checks.push(phase);

    phase = "credential_recovery";
    const replacement = await recover("replace_credential");
    requireStatus((await client.identify()).status, 401);
    client.useCredential(text(replacement.credential));
    requireStatus((await client.identify()).status, 200);
    checks.push(phase);

    phase = "recovery_key_replacement";
    const next = createAutonomousAgentFixture().recovery;
    await recover("replace_recovery_key", next.publicKey);
    signer = next;
    checks.push(phase);

    phase = "agent_export";
    const exported = await client.exportOwnAgent();
    requireStatus(exported.status, 200);
    assertOperationResponseMatchesContract(
      client.contract,
      "exportOwnAgent",
      exported,
    );
    const exportedData = record(record(exported.body).data);
    const exportedActivity = exportedData.publicActivity;
    if (
      !Array.isArray(exportedActivity) ||
      !social.activityIds.every((id) =>
        exportedActivity.some((item: unknown) => record(item).id === id),
      )
    )
      throw new Error("Export omitted Agent activity.");
    const exportText = JSON.stringify(exported.body);
    if (
      record(exportedData.agent).id !== agentId ||
      exportedData.format !== "nobody-asked.agent-export" ||
      exportText.includes(text(replacement.credential)) ||
      /internalNote|requestOrigin|secretDigest|privateKey/.test(exportText)
    ) {
      throw new Error("Export boundary failed.");
    }
    checks.push(phase);

    phase = "retired_operator_registration";
    const retired = await fetch(new URL("/v1/operator/agents", baseUrl), {
      signal: AbortSignal.timeout(15000),
      method: "POST",
      redirect: "error",
    });
    requireStatus(retired.status, 404);
    checks.push(phase);

    phase = "self_stop";
    await recover("stop_agent");
    stopped = true;
    requireStatus((await client.identify()).status, 401);
    checks.push(phase);
    const unverifiedOperationIds =
      options.audience === "autonomous"
        ? [
            ...client.assertAutonomousCapabilitiesWereExercised(social.peer),
            ...Object.values(record(client.contract.paths)).flatMap((path) =>
              Object.values(record(path)).flatMap((value) => {
                const operation = record(value);
                return operation["x-capability-audience"] ===
                  "optional-operator" &&
                  Array.isArray(operation.tags) &&
                  operation.tags.includes("Operator commands")
                  ? [text(operation.operationId)]
                  : [];
              }),
            ),
          ].sort()
        : [];
    if (options.audience !== "autonomous")
      client.assertEveryDiscoveredCapabilityWasExercised(
        social.peer,
        ...(options.additionalCoverageClients ?? []),
      );
    console.log(
      JSON.stringify({
        result: "pass",
        origin: baseUrl.origin,
        runId,
        agentId,
        handle,
        retainedPublicIdentity: true,
        checks,
        peerAgentId: social.peerId,
        unverifiedOperationIds,
        unverified: [
          "moderator_authenticated_actions",
          "operator_authenticated_actions",
        ],
      }),
    );
  } catch {
    passed = false;
    console.error(
      JSON.stringify({
        result: "fail",
        phase,
        origin: baseUrl.origin,
        runId,
        agentId,
        handle,
        checks,
      }),
    );
  } finally {
    if (agentId && client && !stopped) {
      try {
        await recover("stop_agent");
        console.log(JSON.stringify({ cleanup: "stopped", agentId }));
      } catch {
        passed = false;
        console.error(
          JSON.stringify({ cleanup: "requires_review", agentId, handle }),
        );
      }
    }
  }

  return passed;
}
