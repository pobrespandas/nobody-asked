import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { HttpAgentClient } from "./agent-client.js";
import { createAutonomousAgentFixture } from "./autonomous-agent-fixture.js";
import {
  asRecord,
  assertOperationResponseMatchesContract,
  assertResponseMatchesContract,
} from "./contract-assertions.js";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export async function verifyOperatorAuthorization(input: {
  firestore: Firestore;
  baseUrl: URL;
  operatorId: string;
  operatorCookie: string;
}): Promise<HttpAgentClient> {
  const client = await HttpAgentClient.discover(input.baseUrl);
  const fixture = createAutonomousAgentFixture({
    handle: "optional_operator_fixture",
    displayName: "Optional Operator fixture",
  });
  const check = (
    id: string,
    result: { status: number; body: unknown },
    status: number,
  ) => {
    assert(
      result.status === status,
      `Optional Operator ${id} returned another status.`,
    );
    assertOperationResponseMatchesContract(client.contract, id, result);
    return asRecord(asRecord(result.body).data);
  };
  const start = check(
    "startAgentRegistration",
    await client.startRegistration(
      fixture.profile,
      fixture.recovery.publicKey,
      "optional-register",
    ),
    201,
  );
  const registered = check(
    "completeAgentRegistration",
    await client.completeRegistration(
      String(start.registrationId),
      String(start.challenge),
      fixture.recovery.signMessage(String(asRecord(start.proof).message)),
    ),
    201,
  );
  const agentId = String(registered.agentId);
  client.useCredential(String(registered.credential));
  const operatorRequest = async (
    path: string,
    method: "get" | "post",
    cookie: string,
    body?: unknown,
    key = "optional-control",
  ) => {
    const response = await fetch(new URL(path, input.baseUrl), {
      method: method.toUpperCase(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        origin: "https://operator.example",
        cookie: cookie.split(";", 1)[0]!,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", "idempotency-key": key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  const initial = check(
    "getAgentOperatorAuthorization",
    await client.readOperatorAuthorization(),
    200,
  );
  assert(
    initial.revision === 0 && initial.authorization === null,
    "The autonomous Agent already had Operator authority.",
  );
  const pending = check(
    "createAgentOperatorAuthorization",
    await client.createOperatorAuthorization(
      input.operatorId,
      0,
      "optional-grant-first",
    ),
    201,
  );
  const denied = await operatorRequest(
    `/v1/operator/agents/${agentId}/export`,
    "get",
    input.operatorCookie,
  );
  assert(denied.status === 403, "Pending authorization granted control.");
  const accept = await operatorRequest(
    `/v1/operator/agent-authorizations/${pending.authorizationId}/accept`,
    "post",
    input.operatorCookie,
    {},
    "optional-accept-first",
  );
  const accepted = check("acceptAgentOperatorAuthorization", accept, 200);
  const active = check(
    "getAgentOperatorAuthorization",
    await client.readOperatorAuthorization(),
    200,
  );
  assert(
    asRecord(active.authorization).operatorId === input.operatorId &&
      asRecord(active.authorization).status === "active",
    "Acceptance did not activate the intended Operator.",
  );
  const exported = await operatorRequest(
    `/v1/operator/agents/${agentId}/export`,
    "get",
    input.operatorCookie,
  );
  assert(
    exported.status === 200,
    "Accepted Operator could not export its authorized Agent.",
  );
  assertResponseMatchesContract(
    client.contract,
    "/v1/operator/agents/{agentId}/export",
    "get",
    exported,
  );
  assert(
    asRecord(asRecord(exported.body).data).agent !== undefined &&
      !JSON.stringify(exported.body).includes(input.operatorId),
    "Export exposed Operator authority.",
  );
  const rotated = await operatorRequest(
    `/v1/operator/agents/${agentId}/credentials/rotate`,
    "post",
    input.operatorCookie,
    {},
    "optional-rotate",
  );
  assert(
    rotated.status === 200,
    "Accepted Operator could not rotate the Agent Credential.",
  );
  assertResponseMatchesContract(
    client.contract,
    "/v1/operator/agents/{agentId}/credentials/rotate",
    "post",
    rotated,
  );
  client.useCredential(
    String(asRecord(asRecord(rotated.body).data).credential),
  );
  const removed = check(
    "removeAgentOperatorAuthorization",
    await client.removeOperatorAuthorization(
      Number(accepted.revision),
      "optional-remove-first",
    ),
    200,
  );
  assert(
    (
      await operatorRequest(
        `/v1/operator/agents/${agentId}/export`,
        "get",
        input.operatorCookie,
      )
    ).status === 403,
    "Removed Operator retained control.",
  );
  // Seed only private recipient proof. The API creates the second Operator and session.
  const identity = "second-optional-operator@example.test";
  const invitationId = "optional-second-invitation";
  const challengeId = "optional-second-challenge";
  const invitationSecret = "optional-second-invitation-secret";
  const challengeSecret = "optional-second-challenge-secret";
  await input.firestore
    .collection("operatorInvitations")
    .doc(invitationId)
    .set({
      intendedIdentity: identity,
      secretDigest: hash(invitationSecret),
      expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
      acceptedAt: null,
      acceptedOperatorId: null,
      recipientProofAt: null,
      revokedAt: null,
    });
  await input.firestore
    .collection("operatorChallenges")
    .doc(challengeId)
    .set({
      normalizedIdentity: identity,
      secretDigest: hash(challengeSecret),
      expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
      consumedAt: null,
    });
  const enrollmentResponse = await fetch(
    new URL(`/v1/operator/invitations/${invitationId}/accept`, input.baseUrl),
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        origin: "https://operator.example",
        "content-type": "application/json",
        "idempotency-key": "optional-enroll-second",
      },
      body: JSON.stringify({ invitationSecret, challengeId, challengeSecret }),
    },
  );
  const enrollment = {
    status: enrollmentResponse.status,
    body: (await enrollmentResponse.json()) as unknown,
  };
  assertResponseMatchesContract(
    client.contract,
    "/v1/operator/invitations/{invitationId}/accept",
    "post",
    enrollment,
  );
  assert(enrollment.status === 201, "Second Operator enrollment failed.");
  const secondId = String(asRecord(asRecord(enrollment.body).data).operatorId);
  const secondCookie = enrollmentResponse.headers.get("set-cookie");
  assert(
    secondCookie && secondId !== input.operatorId,
    "Second Operator was not distinct.",
  );
  const next = check(
    "createAgentOperatorAuthorization",
    await client.createOperatorAuthorization(
      secondId,
      Number(removed.revision),
      "optional-grant-second",
    ),
    201,
  );
  assert(
    next.authorizationId !== pending.authorizationId,
    "Regrant reused a removed authorization ID.",
  );
  const replay = check(
    "createAgentOperatorAuthorization",
    await client.createOperatorAuthorization(
      input.operatorId,
      0,
      "optional-grant-first",
    ),
    201,
  );
  assert(
    replay.authorizationId === pending.authorizationId,
    "Idempotent replay changed its receipt.",
  );
  const stillPending = check(
    "getAgentOperatorAuthorization",
    await client.readOperatorAuthorization(),
    200,
  );
  assert(
    asRecord(stillPending.authorization).authorizationId ===
      next.authorizationId,
    "Stale replay resurrected old authority.",
  );
  const secondAccepted = check(
    "acceptAgentOperatorAuthorization",
    await operatorRequest(
      `/v1/operator/agent-authorizations/${next.authorizationId}/accept`,
      "post",
      secondCookie,
      {},
      "optional-accept-second",
    ),
    200,
  );
  assert(
    (
      await operatorRequest(
        `/v1/operator/agents/${agentId}/export`,
        "get",
        secondCookie,
      )
    ).status === 200,
    "New Operator did not obtain control after explicit removal.",
  );
  check(
    "removeAgentOperatorAuthorization",
    await client.removeOperatorAuthorization(
      Number(secondAccepted.revision),
      "optional-remove-second",
    ),
    200,
  );
  const recovery = check(
    "startAgentRecovery",
    await client.startRecovery(agentId, "optional-cleanup", "stop_agent"),
    201,
  );
  check(
    "completeAgentRecovery",
    await client.completeRecovery(
      agentId,
      String(recovery.challengeId),
      String(recovery.challenge),
      fixture.recovery.signMessage(String(asRecord(recovery.proof).message)),
      "optional-cleanup-complete",
      "stop_agent",
    ),
    200,
  );
  return client;
}
