import { randomUUID } from "node:crypto";
import { HttpAgentClient } from "./agent-client.js";
import { createAutonomousAgentFixture } from "./autonomous-agent-fixture.js";
import { assertOperationResponseMatchesContract } from "./contract-assertions.js";

type Operation = "replace_credential" | "replace_recovery_key" | "stop_agent";
type Signer = ReturnType<typeof createAutonomousAgentFixture>["recovery"];
type Response = { status: number; body: unknown };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid response.");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value)
    throw new Error("Missing response field.");
  return value;
};
function requireCheck(condition: boolean): void {
  if (!condition) throw new Error("Conformance check failed.");
}

export async function runRecoveryKeyRevocationConformance(
  baseUrl: URL,
): Promise<boolean> {
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const fixture = createAutonomousAgentFixture({
    handle: `revoke_${runId}`,
    displayName: "Recovery Revocation Agent",
  });
  const keyA = fixture.recovery;
  const keyB = createAutonomousAgentFixture().recovery;
  let signer = keyA;
  let client: HttpAgentClient | undefined;
  let agentId: string | undefined;
  let phase = "discovery";
  let passed = false;
  const checks: string[] = [];
  let sequence = 0;

  function checkResponse(
    operation: string,
    response: Response,
    status: number,
  ) {
    requireCheck(response.status === status);
    assertOperationResponseMatchesContract(
      client!.contract,
      operation,
      response,
    );
  }
  async function pending(
    operation: Operation,
    key: Signer,
    replacement?: Signer,
  ) {
    const serial = ++sequence;
    const start = await client!.startRecovery(
      agentId!,
      `${runId}-${serial}-start`,
      operation,
      replacement?.publicKey,
    );
    checkResponse("startAgentRecovery", start, 201);
    const data = record(record(start.body).data);
    const signature = key.signMessage(text(record(data.proof).message));
    return () =>
      client!.completeRecovery(
        agentId!,
        text(data.challengeId),
        text(data.challenge),
        signature,
        `${runId}-${serial}-complete`,
        operation,
        replacement?.publicKey,
      );
  }
  async function active() {
    const identity = await client!.identify();
    checkResponse("getAuthenticatedAgent", identity, 200);
    const agent = record(record(record(identity.body).data).agent);
    requireCheck(agent.id === agentId && agent.status === "active");
  }
  async function replace(next: Signer) {
    const complete = await pending("replace_recovery_key", signer, next);
    const changed = await complete();
    checkResponse("completeAgentRecovery", changed, 200);
    signer = next;
    requireCheck(!JSON.stringify(changed.body).includes('"credential"'));
    const replay = await complete();
    checkResponse("completeAgentRecovery", replay, 200);
    requireCheck(JSON.stringify(replay.body) === JSON.stringify(changed.body));
    await active();
  }
  try {
    client = await HttpAgentClient.discover(baseUrl);
    phase = "registration";
    const start = await client.startRegistration(
      fixture.profile,
      keyA.publicKey,
      `${runId}-register`,
    );
    checkResponse("startAgentRegistration", start, 201);
    const challenge = record(record(start.body).data);
    const registration = await client.completeRegistration(
      text(challenge.registrationId),
      text(challenge.challenge),
      keyA.signMessage(text(record(challenge.proof).message)),
    );
    checkResponse("completeAgentRegistration", registration, 201);
    const registered = record(record(registration.body).data);
    agentId = text(registered.agentId);
    client.useCredential(text(registered.credential));
    await active();
    checks.push("registration");

    phase = "prepare_old_proofs";
    const oldProofs = [
      await pending("replace_credential", keyA),
      await pending("stop_agent", keyA),
      await pending(
        "replace_recovery_key",
        keyA,
        createAutonomousAgentFixture().recovery,
      ),
    ];
    phase = "replace_A_with_B";
    await replace(keyB);
    checks.push("replace_A_with_B", "completed_replacement_replay");
    for (const round of ["revoked_key", "restored_public_key"] as const) {
      if (round === "restored_public_key") {
        phase = "replace_B_with_A";
        await replace(keyA);
        checks.push("replace_B_with_A");
      }
      phase = `reject_old_proofs_${round}`;
      for (const complete of oldProofs) {
        const rejected = await complete();
        checkResponse("completeAgentRecovery", rejected, 401);
        requireCheck(
          record(record(rejected.body).error).code ===
            "recovery_proof_rejected",
        );
        requireCheck(!JSON.stringify(rejected.body).includes('"credential"'));
        await active();
      }
      checks.push(phase);
    }
    passed = true;
  } catch {
    console.error(JSON.stringify({ result: "fail", phase, agentId, checks }));
  } finally {
    if (agentId && client) {
      try {
        const complete = await pending("stop_agent", signer);
        const stopped = await complete();
        checkResponse("completeAgentRecovery", stopped, 200);
        requireCheck(record(record(stopped.body).data).status === "stopped");
        requireCheck((await client.identify()).status === 401);
        checks.push("cleanup_self_stop");
      } catch {
        passed = false;
        console.error(
          JSON.stringify({
            result: "fail",
            phase: "cleanup_requires_review",
            agentId,
            checks,
          }),
        );
      }
    }
  }
  if (passed)
    console.log(
      JSON.stringify({
        result: "pass",
        agentId,
        retainedPublicIdentity: true,
        checks,
      }),
    );
  return passed;
}
