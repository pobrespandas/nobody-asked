import { randomUUID } from "node:crypto";
import { HttpAgentClient } from "./agent-client.js";
import { createAutonomousAgentFixture } from "./autonomous-agent-fixture.js";
import {
  asRecord,
  assertOperationResponseMatchesContract,
} from "./contract-assertions.js";
import { validateConformanceOrigin } from "./hosted-conformance.js";
interface OperatorContext {
  readonly operatorId: string;
  readonly operatorCookie: string;
}
export interface OperatorReauthorizationReport {
  readonly result: "pass" | "fail";
  readonly phase: string;
  readonly agentId: string | null;
  readonly handle: string;
  readonly checks: readonly string[];
  readonly cleanup: "stopped" | "not-created" | "cleanup_requires_review";
}
// Sessions, Credentials, and Recovery keys remain in memory. This sends no email.
export async function verifyHostedOperatorReauthorization(input: {
  readonly baseUrl: URL;
  readonly origin: string;
  readonly mainOperator: OperatorContext;
  readonly peerOperator: OperatorContext;
}): Promise<OperatorReauthorizationReport> {
  const baseUrl = validateConformanceOrigin(input.baseUrl.href);
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    throw new Error("Invalid Operator reauthorization input.");
  }
  if (
    origin.origin !== input.origin ||
    !["http:", "https:"].includes(origin.protocol) ||
    input.mainOperator.operatorId === input.peerOperator.operatorId
  )
    throw new Error("Invalid Operator reauthorization input.");
  for (const context of [input.mainOperator, input.peerOperator])
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(context.operatorId) ||
      !/^__session=[^\s;\r\n]+$/.test(
        context.operatorCookie.split(";", 1)[0] ?? "",
      )
    )
      throw new Error("Invalid Operator reauthorization input.");
  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const fixture = createAutonomousAgentFixture({
    handle: `operator_reauth_${runId}`,
    displayName: "Synthetic Operator reauthorization",
  });
  let phase = "discovery";
  let agentId: string | null = null;
  let completionAttempted = false;
  let client: HttpAgentClient | undefined;
  let deadline = Date.now() + 180_000;
  let passed = false;
  let cleanup: OperatorReauthorizationReport["cleanup"] = "not-created";
  const checks: string[] = [];
  const guard = () => {
    if (Date.now() >= deadline)
      throw new Error("Operator reauthorization deadline reached.");
  };
  const check = (
    id: string,
    result: { status: number; body: unknown },
    expected: number,
  ) => {
    if (result.status !== expected)
      throw new Error("Operator reauthorization status mismatch.");
    assertOperationResponseMatchesContract(client!.contract, id, result);
    return asRecord(result.body);
  };
  const agent = async (
    id: string,
    request: () => Promise<{ status: number; body: unknown }>,
    status = 200,
  ) => {
    guard();
    return check(id, await request(), status);
  };
  const operator = async (
    context: OperatorContext,
    id: string,
    parameters: Record<string, string>,
    body?: unknown,
    key?: string,
    expected = 200,
  ) => {
    guard();
    let selected: { path: string; method: string } | undefined;
    for (const [path, item] of Object.entries(asRecord(client!.contract.paths)))
      for (const method of ["get", "post", "put", "delete"]) {
        const candidate = asRecord(item)[method];
        if (candidate && asRecord(candidate).operationId === id)
          selected = { path, method };
      }
    if (!selected)
      throw new Error("Operator operation is absent from discovery.");
    const resolved = selected.path.replaceAll(
      /\{([^}]+)\}/g,
      (_match, name: string) => {
        if (!parameters[name])
          throw new Error("Missing Operator route parameter.");
        return encodeURIComponent(parameters[name]!);
      },
    );
    const url = new URL(resolved, baseUrl);
    if (url.origin !== baseUrl.origin)
      throw new Error("Operator route changed origin.");
    const response = await fetch(url, {
      method: selected.method.toUpperCase(),
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.min(15_000, Math.max(1, deadline - Date.now())),
      ),
      headers: {
        origin: input.origin,
        cookie: context.operatorCookie.split(";", 1)[0]!,
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": key ?? `${runId}-${phase}-${id}`,
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return check(
      id,
      { status: response.status, body: (await response.json()) as unknown },
      expected,
    );
  };
  const exportAgent = async (context: OperatorContext, status: number) =>
    operator(
      context,
      "exportControlledAgent",
      { agentId: agentId! },
      undefined,
      undefined,
      status,
    );
  try {
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
              `${runId}-registration`,
            ),
          201,
        )
      ).data,
    );
    completionAttempted = true;
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
    if (typeof registered.agentId !== "string")
      throw new Error("Missing synthetic Agent identity.");
    agentId = registered.agentId;
    client.useCredential(String(registered.credential));
    checks.push(phase);
    phase = "first_operator_authorized";
    const initial = asRecord(
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
              input.mainOperator.operatorId,
              Number(initial.revision),
              `${runId}-grant-main`,
            ),
          201,
        )
      ).data,
    );
    const acceptedFirst = asRecord(
      (
        await operator(
          input.mainOperator,
          "acceptAgentOperatorAuthorization",
          { authorizationId: String(first.authorizationId) },
          {},
          `${runId}-accept-main`,
        )
      ).data,
    );
    await exportAgent(input.mainOperator, 200);
    checks.push(phase);
    phase = "explicit_removal";
    const removed = asRecord(
      (
        await agent("removeAgentOperatorAuthorization", () =>
          client!.removeOperatorAuthorization(
            Number(acceptedFirst.revision),
            `${runId}-remove-main`,
          ),
        )
      ).data,
    );
    await exportAgent(input.mainOperator, 403);
    checks.push(phase);
    phase = "distinct_operator_authorized";
    const second = asRecord(
      (
        await agent(
          "createAgentOperatorAuthorization",
          () =>
            client!.createOperatorAuthorization(
              input.peerOperator.operatorId,
              Number(removed.revision),
              `${runId}-grant-peer`,
            ),
          201,
        )
      ).data,
    );
    if (second.authorizationId === first.authorizationId)
      throw new Error("A new grant reused its authorization identity.");
    await operator(
      input.peerOperator,
      "acceptAgentOperatorAuthorization",
      { authorizationId: String(second.authorizationId) },
      {},
      `${runId}-accept-peer`,
    );
    await exportAgent(input.mainOperator, 403);
    await operator(
      input.mainOperator,
      "rotateAgentCredential",
      { agentId },
      {},
      `${runId}-denied-main-rotation`,
      403,
    );
    const exported = await exportAgent(input.peerOperator, 200);
    if (
      asRecord(asRecord(exported.data).agent).id !== agentId ||
      JSON.stringify(exported).includes(input.mainOperator.operatorId) ||
      JSON.stringify(exported).includes(input.peerOperator.operatorId)
    )
      throw new Error("Operator export privacy mismatch.");
    const rotated = asRecord(
      (
        await operator(
          input.peerOperator,
          "rotateAgentCredential",
          { agentId },
          {},
          `${runId}-peer-rotation`,
        )
      ).data,
    );
    client.useCredential(String(rotated.credential));
    await agent("getAuthenticatedAgent", () => client!.identify());
    checks.push(phase);
    phase = "old_acceptance_replay";
    const replay = asRecord(
      (
        await operator(
          input.mainOperator,
          "acceptAgentOperatorAuthorization",
          { authorizationId: String(first.authorizationId) },
          {},
          `${runId}-accept-main`,
        )
      ).data,
    );
    if (
      Object.keys(replay).length !== Object.keys(acceptedFirst).length ||
      Object.keys(acceptedFirst).some(
        (key) => replay[key] !== acceptedFirst[key],
      )
    )
      throw new Error("Acceptance replay changed its receipt.");
    const current = asRecord(
      (
        await agent("getAgentOperatorAuthorization", () =>
          client!.readOperatorAuthorization(),
        )
      ).data,
    );
    if (
      asRecord(current.authorization).operatorId !==
        input.peerOperator.operatorId ||
      asRecord(current.authorization).authorizationId !== second.authorizationId
    )
      throw new Error("Old acceptance replay changed current authority.");
    await exportAgent(input.mainOperator, 403);
    await exportAgent(input.peerOperator, 200);
    checks.push(phase);
    phase = "final_removal";
    await agent("removeAgentOperatorAuthorization", () =>
      client!.removeOperatorAuthorization(
        Number(current.revision),
        `${runId}-remove-peer`,
      ),
    );
    await exportAgent(input.peerOperator, 403);
    checks.push(phase);
    passed = true;
  } catch {
    // Return fixed phases and public synthetic metadata only.
  } finally {
    deadline = Date.now() + 60_000;
    if (client && !agentId && completionAttempted) {
      cleanup = "cleanup_requires_review";
      try {
        const profile = await client.readPublic("getAgent", {
          handle: fixture.profile.handle,
        });
        if (profile.status === 200) {
          check("getAgent", profile, 200);
          const found = asRecord(asRecord(profile.body).data).id;
          if (
            typeof found === "string" &&
            /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(found)
          )
            agentId = found;
        }
      } catch {}
    }
    if (client && agentId) {
      cleanup = "cleanup_requires_review";
      try {
        if (!passed) {
          const remove = asRecord(
            (
              await agent(
                "startAgentRecovery",
                () =>
                  client!.startRecovery(
                    agentId!,
                    `${runId}-cleanup-authority`,
                    "remove_operator_authorization",
                  ),
                201,
              )
            ).data,
          );
          await agent("completeAgentRecovery", () =>
            client!.completeRecovery(
              agentId!,
              String(remove.challengeId),
              String(remove.challenge),
              fixture.recovery.signMessage(
                String(asRecord(remove.proof).message),
              ),
              `${runId}-cleanup-authority-complete`,
              "remove_operator_authorization",
              undefined,
              Number(remove.authorizationRevision),
            ),
          );
        }
        const proof = asRecord(
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
            String(proof.challengeId),
            String(proof.challenge),
            fixture.recovery.signMessage(String(asRecord(proof.proof).message)),
            `${runId}-cleanup-stop-complete`,
            "stop_agent",
          ),
        );
        if (asRecord(stopped.data).status !== "stopped")
          throw new Error("Cleanup did not stop synthetic activity.");
        await agent("getAuthenticatedAgent", () => client!.identify(), 401);
        cleanup = "stopped";
      } catch {}
    }
  }
  return {
    result: passed && cleanup === "stopped" ? "pass" : "fail",
    phase,
    agentId,
    handle: fixture.profile.handle,
    checks,
    cleanup,
  };
}
