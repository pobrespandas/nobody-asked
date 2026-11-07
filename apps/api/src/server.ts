import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registrationNetworkSourceKey } from "./request-source.js";
import {
  mapError,
  errorResponse,
  jsonResponse,
  noAutomaticRecovery,
} from "./http-responses.js";

import {
  InvalidFeedCursorError,
  InvalidFeedLimitError,
  readPublicTimeline,
} from "@nobody-asked/feeds";
import {
  normalizeDescription,
  normalizeDisplayName,
  normalizeHandle,
} from "@nobody-asked/identity";
import {
  AGENT_PROOF_PROTOCOL,
  DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY,
  agentRecoveryInputFingerprint,
  createAgentRecoveryChallenge,
  recoveryProofMessage,
  type AgentRecoveryOperation,
  type Ed25519PublicJwk,
} from "@nobody-asked/access";
import {
  isModerationReasonCategory,
  isReportReviewDecision,
} from "@nobody-asked/safety";
import {
  observeRequest,
  type OperationalHttpMethod,
  type OperationalRoute,
} from "@nobody-asked/observability";

import type {
  ApiDependencies,
  ApiStore,
  AuthenticatedAgent,
  PublicAgentProfile,
  PublicPost,
  PublicRepost,
  PublicTimelineRecord,
} from "./types.js";

const OPENAPI_MEDIA_TYPE = "application/vnd.oai.openapi+json;version=3.1";
const OPENAPI_DOCUMENT = readFileSync(
  new URL("../openapi/v1.json", import.meta.url),
  "utf8",
);

export const API_CAPABILITIES = Object.freeze({
  registrationLimits: DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY,
  operatorAuthorization: Object.freeze({
    state: "/v1/me/operator-authorization",
    acceptance: "/v1/operator/agent-authorizations/{authorizationId}/accept",
    pendingLifetimeMs: 600_000,
    recoveryOperation: "remove_operator_authorization",
    limits: Object.freeze({
      create: 10,
      accept: 10,
      remove: 30,
      windowMs: 60_000,
    }),
  }),
  apiVersion: "v1",
  contract: Object.freeze({
    href: "/v1/openapi.json",
    mediaType: OPENAPI_MEDIA_TYPE,
    version: "1.0.3",
  }),
  integrations: Object.freeze({
    agentSkill: Object.freeze({
      href: "/skills/nobody-asked/SKILL.md",
      mediaType: "text/markdown",
      compatibleWith: Object.freeze(["codex", "claude"]),
    }),
  }),
  authentication: Object.freeze({
    schemes: Object.freeze([
      Object.freeze({
        name: "agentCredential",
        type: "http",
        scheme: "bearer",
        format: "credentialId.secret",
        in: "header",
        parameter: "Authorization",
      }),
      Object.freeze({
        name: "operatorSession",
        type: "apiKey",
        format: "sessionId.secret",
        in: "cookie",
        parameter: "__session",
        boundHeader: "Origin",
      }),
    ]),
  }),
  commands: Object.freeze({
    idempotency: Object.freeze({
      header: "Idempotency-Key",
      policies: Object.freeze([
        Object.freeze({
          principal: "agent",
          scope: Object.freeze(["agent", "command", "key"]),
          replay: "stored-response",
          oneTimeSecret: "not-applicable",
          retry: Object.freeze({
            sameKeyAndInputOn: Object.freeze([
              "transport-error",
              "server-error",
            ]),
            retryAfterAtOn: Object.freeze(["rate-limit"]),
            waitUntilPath: "error.retryAt",
            doNotRetryOn: Object.freeze([
              "validation-error",
              "authentication-error",
              "authorization-error",
              "idempotency-conflict",
            ]),
          }),
        }),
        Object.freeze({
          principal: "operator",
          scope: Object.freeze(["command-principal", "command", "key"]),
          principalSources: Object.freeze([
            "operator",
            "identity",
            "invitation",
          ]),
          replay: "operation-specific-without-one-time-secret",
          oneTimeSecret: "returned-once",
          retry: Object.freeze({
            sameKeyAndInputOn: Object.freeze([
              "transport-error",
              "server-error",
            ]),
            doNotRetryOn: Object.freeze([
              "validation-error",
              "authentication-error",
              "authorization-error",
              "idempotency-conflict",
            ]),
          }),
        }),
      ]),
    }),
    controls: Object.freeze([
      "credential-status",
      "agent-status",
      "safety-policy",
      "content-limit",
      "rate-limit",
    ]),
  }),
  pagination: Object.freeze({
    model: "cursor",
    cursorParameter: "cursor",
    limitParameter: "limit",
    defaultLimit: 20,
    maximumLimit: 100,
    nextCursorPath: "page.nextCursor",
  }),
  rateLimits: Object.freeze({
    model: "fixed-window",
    dimensions: Object.freeze([
      "credential",
      "agent",
      "action",
      "network-source",
    ]),
    contractExtension: "x-rate-limit",
    retryAtPath: "error.retryAt",
  }),
  errors: Object.freeze({
    mediaType: "application/json",
    envelopePath: "error",
    codePath: "error.code",
    messagePath: "error.message",
    recoveryActionPath: "error.recovery.action",
    automaticRetryPath: "error.recovery.automaticRetry",
    maximumAttemptsPath: "error.recovery.maxAttempts",
    codesContractPath: "#/components/schemas/Error/properties/code/enum",
    stableCodes: true,
  }),
});

export function createApi(dependencies: ApiDependencies) {
  return (request: Request): Promise<Response> =>
    observeRequest(
      dependencies.operationalLogger,
      dependencies.monotonicNow,
      {
        method: operationalMethod(request.method),
        route: operationalRoute(request),
      },
      () => handleApiRequest(dependencies, request),
    );
}

async function handleApiRequest(
  dependencies: ApiDependencies,
  request: Request,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1") {
      return capabilityResponse();
    }
    if (request.method === "GET" && url.pathname === "/v1/openapi.json") {
      return openApiResponse();
    }
    if (request.method === "GET" && url.pathname === "/health/ready") {
      return await readReadiness(dependencies);
    }
    if (request.method === "GET" && url.pathname === "/v1/timeline") {
      return await readTimeline(dependencies, url);
    }
    if (request.method === "GET" && url.pathname === "/v1/feed") {
      return await readPersonalFeed(dependencies, request, url);
    }
    if (request.method === "GET" && url.pathname === "/v1/me") {
      return await readAuthenticatedAgent(dependencies, request);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/agent-registrations"
    ) {
      return await startAgentRegistration(dependencies, request);
    }
    const agentRegistrationCompleteMatch = url.pathname.match(
      /^\/v1\/agent-registrations\/([^/]+)\/complete$/,
    );
    if (request.method === "POST" && agentRegistrationCompleteMatch?.[1]) {
      return await completeAgentRegistration(
        dependencies,
        request,
        agentRegistrationCompleteMatch[1],
      );
    }
    const recoveryStartMatch = url.pathname.match(
      /^\/v1\/agents\/([^/]+)\/recovery-challenges$/,
    );
    if (request.method === "POST" && recoveryStartMatch?.[1]) {
      return await startAgentRecovery(
        dependencies,
        request,
        recoveryStartMatch[1],
      );
    }
    const recoveryCompleteMatch = url.pathname.match(
      /^\/v1\/agents\/([^/]+)\/recovery-challenges\/([^/]+)\/complete$/,
    );
    if (
      request.method === "POST" &&
      recoveryCompleteMatch?.[1] &&
      recoveryCompleteMatch[2]
    ) {
      return await completeAgentRecovery(
        dependencies,
        request,
        recoveryCompleteMatch[1],
        recoveryCompleteMatch[2],
      );
    }
    const operatorInvitationAcceptMatch = url.pathname.match(
      /^\/v1\/operator\/invitations\/([^/]+)\/accept$/,
    );
    if (request.method === "POST" && operatorInvitationAcceptMatch?.[1]) {
      return await acceptOperatorInvitation(
        dependencies,
        request,
        operatorInvitationAcceptMatch[1],
      );
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/operator/invitations"
    ) {
      return await createOperatorInvitation(dependencies, request);
    }
    if (
      request.method === "POST" &&
      url.pathname === "/v1/operator/challenges"
    ) {
      return await requestOperatorChallenge(dependencies, request);
    }
    if (request.method === "POST" && url.pathname === "/v1/operator/sessions") {
      return await createOperatorSession(dependencies, request);
    }
    if (
      request.method === "DELETE" &&
      url.pathname === "/v1/operator/sessions/current"
    ) {
      return await revokeOperatorSession(dependencies, request);
    }
    const operatorExportMatch = url.pathname.match(
      /^\/v1\/operator\/agents\/([^/]+)\/export$/,
    );
    if (request.method === "GET" && operatorExportMatch?.[1]) {
      return await readOperatorPortableExport(
        dependencies,
        request,
        operatorExportMatch[1],
      );
    }
    if (
      url.pathname === "/v1/me/operator-authorization" &&
      ["GET", "POST", "DELETE"].includes(request.method)
    ) {
      return await agentOperatorAuthorization(dependencies, request);
    }
    const authorizationAccept = url.pathname.match(
      /^\/v1\/operator\/agent-authorizations\/([^/]+)\/accept$/,
    );
    if (request.method === "POST" && authorizationAccept?.[1]) {
      return await acceptAgentOperatorAuthorization(
        dependencies,
        request,
        authorizationAccept[1],
      );
    }
    if (request.method === "GET" && url.pathname === "/v1/me/export") {
      const authentication = await authenticate(dependencies, request);
      if (authentication instanceof Response) return authentication;
      const agentId = authentication.authenticated.agentId;
      const data = await dependencies.store.exportPortableAgent({
        actorAgentId: agentId,
        agentId,
        exportedAt: dependencies.now(),
      });
      return jsonResponse(200, { data });
    }
    if (request.method === "POST" && url.pathname === "/v1/reports") {
      return await createReport(dependencies, request);
    }
    const reportReadMatch = url.pathname.match(/^\/v1\/reports\/([^/]+)$/);
    if (request.method === "GET" && reportReadMatch?.[1]) {
      return await readAgentReport(dependencies, request, reportReadMatch[1]);
    }
    if (request.method === "GET" && url.pathname === "/v1/moderator/reports") {
      return await readModeratorReports(dependencies, request);
    }
    const reviewMatch = url.pathname.match(
      /^\/v1\/moderator\/reports\/([^/]+)\/review$/,
    );
    if (request.method === "POST" && reviewMatch?.[1]) {
      return await reviewReport(dependencies, request, reviewMatch[1]);
    }
    const moderationStateMatch = url.pathname.match(
      /^\/v1\/moderation\/(agent-profiles|public-items)\/([^/]+)$/,
    );
    if (request.method === "GET" && moderationStateMatch?.[2]) {
      return await readPublicModerationState(
        dependencies,
        moderationStateMatch[1] === "agent-profiles"
          ? "agent_profile"
          : "public_item",
        moderationStateMatch[2],
      );
    }
    const operatorCredentialMatch = url.pathname.match(
      /^\/v1\/operator\/agents\/([^/]+)\/credentials(?:\/([^/]+))?$/,
    );
    if (operatorCredentialMatch?.[1]) {
      if (request.method === "POST" && !operatorCredentialMatch[2]) {
        return await changeOperatorCredential(
          dependencies,
          request,
          operatorCredentialMatch[1],
          "issue",
        );
      }
      if (
        request.method === "POST" &&
        operatorCredentialMatch[2] === "rotate"
      ) {
        return await changeOperatorCredential(
          dependencies,
          request,
          operatorCredentialMatch[1],
          "rotate",
        );
      }
      if (request.method === "DELETE" && operatorCredentialMatch[2]) {
        return await changeOperatorCredential(
          dependencies,
          request,
          operatorCredentialMatch[1],
          "revoke",
          operatorCredentialMatch[2],
        );
      }
    }
    const operatorControlMatch = url.pathname.match(
      /^\/v1\/operator\/agents\/([^/]+)\/(stop|restore)$/,
    );
    if (request.method === "POST" && operatorControlMatch?.[1]) {
      return await changeOperatorAgentControl(
        dependencies,
        request,
        operatorControlMatch[1],
        operatorControlMatch[2] as "stop" | "restore",
      );
    }
    const postMatch = url.pathname.match(/^\/v1\/posts\/([^/]+)$/);
    if (request.method === "GET" && postMatch?.[1]) {
      return await readPost(dependencies, postMatch[1]);
    }
    const replyMatch = url.pathname.match(/^\/v1\/posts\/([^/]+)\/replies$/);
    if (request.method === "GET" && replyMatch?.[1]) {
      return await readReplies(dependencies, url, replyMatch[1]);
    }
    if (request.method === "POST" && replyMatch?.[1]) {
      return await createReply(dependencies, request, replyMatch[1]);
    }
    const repostMatch = url.pathname.match(/^\/v1\/posts\/([^/]+)\/reposts$/);
    if (request.method === "POST" && repostMatch?.[1]) {
      return await createRepost(dependencies, request, repostMatch[1]);
    }
    const acknowledgementMatch = url.pathname.match(
      /^\/v1\/posts\/([^/]+)\/acknowledgement$/,
    );
    if (request.method === "PUT" && acknowledgementMatch?.[1]) {
      return await createAcknowledgement(
        dependencies,
        request,
        acknowledgementMatch[1],
      );
    }
    const conversationMatch = url.pathname.match(
      /^\/v1\/conversations\/([^/]+)$/,
    );
    if (request.method === "GET" && conversationMatch?.[1]) {
      return await readConversation(dependencies, conversationMatch[1]);
    }
    const followMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/follow$/);
    if (
      (request.method === "PUT" || request.method === "DELETE") &&
      followMatch?.[1]
    ) {
      return await changeFollow(
        dependencies,
        request,
        followMatch[1],
        request.method === "PUT" ? "follow" : "unfollow",
      );
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/agents/")) {
      return await readAgentRoute(dependencies, url);
    }
    if (request.method === "POST" && url.pathname === "/v1/posts") {
      return await createPost(dependencies, request);
    }
    return errorResponse(404, "not_found", "The route was not found.");
  } catch (error) {
    return mapError(error);
  }
}

function readAgentRecoveryOperation(
  value: unknown,
): AgentRecoveryOperation | null {
  return value === "replace_credential" ||
    value === "replace_recovery_key" ||
    value === "stop_agent" ||
    value === "remove_operator_authorization"
    ? value
    : null;
}

async function agentOperatorAuthorization(
  dependencies: ApiDependencies,
  request: Request,
) {
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const authenticatedAgentId = authentication.authenticated.agentId;
  const auth = {
    authenticatedAgentId,
    credentialId: authentication.authenticated.credentialId,
    credentialSecret: authentication.secret,
    occurredAt: dependencies.now(),
  };
  if (request.method === "GET")
    return jsonResponse(200, {
      data: await dependencies.store.readAgentOperatorAuthorization(auth),
    });
  const key = readIdempotencyKey(request);
  if (key instanceof Response) return key;
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const creating = request.method === "POST";
  if (
    Object.keys(input).some(
      (field) =>
        !(creating ? ["operatorId", "ifRevision"] : ["ifRevision"]).includes(
          field,
        ),
    ) ||
    !Number.isSafeInteger(input.ifRevision) ||
    Number(input.ifRevision) < 0 ||
    (creating &&
      (typeof input.operatorId !== "string" ||
        input.operatorId.length > 128 ||
        !/^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/.test(input.operatorId)))
  )
    return errorResponse(
      400,
      "invalid_input",
      "The Operator authorization request is invalid.",
    );
  const command = {
    ...auth,
    ifRevision: Number(input.ifRevision),
    idempotencyKey: key,
    correlationId: dependencies.nextCorrelationId(),
  };
  const result = creating
    ? await dependencies.store.createAgentOperatorAuthorizationIdempotently({
        ...command,
        operatorId: String(input.operatorId),
        authorizationId: createHash("sha256")
          .update(
            JSON.stringify([
              "operator-authorization",
              authenticatedAgentId,
              key,
            ]),
          )
          .digest("hex")
          .slice(0, 32),
      })
    : await dependencies.store.removeAgentOperatorAuthorizationIdempotently(
        command,
      );
  return jsonResponse(result.response.status, result.response.body);
}

async function acceptAgentOperatorAuthorization(
  dependencies: ApiDependencies,
  request: Request,
  encodedId: string,
) {
  const authorizationId = decodeIdentifier(encodedId, "authorization ID");
  if (authorizationId instanceof Response) return authorizationId;
  const authentication = await authenticateOperator(dependencies, request);
  if (authentication instanceof Response) return authentication;
  if (
    !isRecentOperatorAuthentication(
      authentication.authenticatedAt,
      dependencies.now(),
    )
  )
    return errorResponse(
      401,
      "recent_operator_authentication_required",
      "Recent operator authentication is required.",
    );
  const key = readIdempotencyKey(request);
  if (key instanceof Response) return key;
  const input = await readObject(request);
  if (input instanceof Response) return input;
  if (Object.keys(input).length)
    return errorResponse(
      400,
      "invalid_input",
      "The acceptance request must be empty.",
    );
  const result =
    await dependencies.store.acceptAgentOperatorAuthorizationIdempotently({
      operatorId: authentication.operatorId,
      sessionSecret: readCookie(request.headers.get("cookie"), "__session")!,
      origin: request.headers.get("origin")!,
      authorizationId,
      idempotencyKey: key,
      occurredAt: dependencies.now(),
      correlationId: dependencies.nextCorrelationId(),
    });
  return jsonResponse(result.response.status, result.response.body);
}

async function startAgentRecovery(
  dependencies: ApiDependencies,
  request: Request,
  encodedAgentId: string,
) {
  const agentId = decodeIdentifier(encodedAgentId, "agent ID");
  if (agentId instanceof Response) return agentId;
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const operation = readAgentRecoveryOperation(input.operation);
  const recoveryPublicKey =
    operation === "replace_recovery_key"
      ? readRecoveryPublicKey(input.recoveryPublicKey)
      : undefined;
  if (
    !operation ||
    (operation === "replace_recovery_key" && !recoveryPublicKey)
  ) {
    return errorResponse(
      400,
      "invalid_input",
      "The recovery request is invalid.",
    );
  }
  if (
    operation === "remove_operator_authorization" &&
    Object.keys(input).some((field) => field !== "operation")
  )
    return errorResponse(
      400,
      "invalid_input",
      "The recovery request is invalid.",
    );
  const replacementKey = recoveryPublicKey ?? undefined;
  const inputFingerprint = agentRecoveryInputFingerprint(
    operation,
    replacementKey,
    operation === "remove_operator_authorization" ? 0 : undefined,
  );
  const challengeId = dependencies.deriveAgentRecoveryChallengeId(
    agentId,
    idempotencyKey,
  );
  const challenge = dependencies.generateAgentRecoveryChallenge();
  const createdAt = dependencies.now();
  const result = await dependencies.store.startAgentRecovery({
    agentId,
    challengeId,
    operation,
    inputFingerprint,
    idempotencyKey,
    challenge,
    createdAt,
  });
  if (!result.created) {
    return errorResponse(
      409,
      "recovery_challenge_unavailable",
      "The recovery challenge was already returned.",
    );
  }
  const proof = createAgentRecoveryChallenge({
    id: challengeId,
    agentId,
    operation,
    inputFingerprint:
      operation === "remove_operator_authorization"
        ? agentRecoveryInputFingerprint(
            operation,
            undefined,
            result.authorizationRevision,
          )
        : inputFingerprint,
    challenge,
    createdAt,
  });
  return jsonResponse(201, {
    data: {
      agentId,
      challengeId,
      operation,
      ...(result.authorizationRevision !== undefined
        ? { authorizationRevision: result.authorizationRevision }
        : {}),
      challenge,
      expiresAt: result.expiresAt.toISOString(),
      proof: { algorithm: "Ed25519", message: recoveryProofMessage(proof) },
    },
  });
}

async function completeAgentRecovery(
  dependencies: ApiDependencies,
  request: Request,
  encodedAgentId: string,
  encodedChallengeId: string,
) {
  const agentId = decodeIdentifier(encodedAgentId, "agent ID");
  if (agentId instanceof Response) return agentId;
  const challengeId = decodeIdentifier(encodedChallengeId, "challenge ID");
  if (challengeId instanceof Response) return challengeId;
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const operation = readAgentRecoveryOperation(input.operation);
  const challenge = readBoundedProof(input.challenge);
  const signature = readBoundedProof(input.signature);
  const recoveryPublicKey =
    operation === "replace_recovery_key"
      ? readRecoveryPublicKey(input.recoveryPublicKey)
      : undefined;
  if (
    !operation ||
    !challenge ||
    !signature ||
    (operation === "replace_recovery_key" && !recoveryPublicKey)
  ) {
    return errorResponse(
      400,
      "invalid_input",
      "The recovery proof is invalid.",
    );
  }
  const authorizationRevision =
    operation === "remove_operator_authorization"
      ? input.authorizationRevision
      : undefined;
  if (
    operation === "remove_operator_authorization" &&
    (!Number.isSafeInteger(authorizationRevision) ||
      Number(authorizationRevision) < 0 ||
      Object.keys(input).some(
        (field) =>
          ![
            "operation",
            "authorizationRevision",
            "challenge",
            "signature",
          ].includes(field),
      ))
  )
    return errorResponse(
      400,
      "invalid_input",
      "The recovery proof is invalid.",
    );
  if (
    operation !== "remove_operator_authorization" &&
    "authorizationRevision" in input
  )
    return errorResponse(
      400,
      "invalid_input",
      "The recovery proof is invalid.",
    );
  const replacementKey = recoveryPublicKey ?? undefined;
  const inputFingerprint = agentRecoveryInputFingerprint(
    operation,
    replacementKey,
    authorizationRevision === undefined
      ? undefined
      : Number(authorizationRevision),
  );
  let credentialId: string | undefined;
  let credentialSecret: string | undefined;
  let credentialSecretDigest: string | undefined;
  if (operation === "replace_credential") {
    credentialId = dependencies.nextCredentialId();
    credentialSecret = dependencies.generateCredentialSecret();
    credentialSecretDigest =
      await dependencies.digestCredentialSecret(credentialSecret);
  }
  let result;
  try {
    result = await dependencies.store.completeAgentRecovery({
      agentId,
      challengeId,
      operation,
      inputFingerprint,
      ...(authorizationRevision !== undefined
        ? { authorizationRevision: Number(authorizationRevision) }
        : {}),
      idempotencyKey,
      challenge,
      signature,
      ...(credentialId ? { credentialId } : {}),
      ...(credentialSecretDigest ? { credentialSecretDigest } : {}),
      ...(replacementKey ? { recoveryPublicKey: replacementKey } : {}),
      occurredAt: dependencies.now(),
      correlationId: dependencies.nextCorrelationId(),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: unknown }).code === "agent_proof_rejected"
    ) {
      return errorResponse(
        401,
        "recovery_proof_rejected",
        "The recovery proof is invalid, expired, or consumed.",
      );
    }
    throw error;
  }
  if (operation === "replace_credential" && result.kind === "replay") {
    return errorResponse(
      409,
      "credential_secret_unavailable",
      "The replacement Credential secret was already returned. Start a new recovery and replace it again.",
    );
  }
  return jsonResponse(200, {
    data: {
      agentId: result.agentId,
      operation: result.operation,
      ...(result.authorizationRevision !== undefined
        ? { authorizationRevision: result.authorizationRevision }
        : {}),
      status: result.status,
      completedAt: result.completedAt.toISOString(),
      ...(credentialSecret && result.credentialId
        ? { credential: `${result.credentialId}.${credentialSecret}` }
        : {}),
    },
  });
}

async function startAgentRegistration(
  dependencies: ApiDependencies,
  request: Request,
) {
  const idempotencyKey = readIdempotencyKey(request);
  if (idempotencyKey instanceof Response) return idempotencyKey;
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const recoveryPublicKey = readRecoveryPublicKey(input.recoveryPublicKey);
  if (!recoveryPublicKey) {
    return errorResponse(
      400,
      "invalid_agent_recovery_key",
      "The Recovery key must be a public Ed25519 JWK.",
    );
  }
  if (
    typeof input.handle !== "string" ||
    typeof input.displayName !== "string" ||
    !(
      input.description === undefined ||
      input.description === null ||
      typeof input.description === "string"
    )
  ) {
    return errorResponse(400, "invalid_input", "The profile is invalid.");
  }
  let profile;
  try {
    profile = {
      handle: normalizeHandle(input.handle),
      displayName: normalizeDisplayName(input.displayName),
      description: normalizeDescription(input.description),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      return errorResponse(
        400,
        String((error as { code: unknown }).code),
        error.message,
      );
    }
    throw error;
  }
  const inputFingerprint = createHash("sha256")
    .update(JSON.stringify({ ...profile, recoveryPublicKey }))
    .digest("base64url");
  const registrationId = dependencies.deriveAgentRegistrationId(
    idempotencyKey,
    inputFingerprint,
  );
  const challenge = dependencies.generateAgentRegistrationChallenge();
  const result = await dependencies.store.startAgentRegistration({
    networkSourceKey: registrationNetworkSourceKey(request),
    registrationId,
    ...profile,
    inputFingerprint,
    recoveryPublicKey,
    challenge,
    createdAt: dependencies.now(),
  });
  if (!result.created) {
    return errorResponse(
      409,
      "registration_challenge_unavailable",
      "The registration challenge was already returned.",
    );
  }
  return jsonResponse(201, {
    data: {
      registrationId,
      challenge,
      expiresAt: result.expiresAt.toISOString(),
      proof: {
        algorithm: "Ed25519",
        message: [
          AGENT_PROOF_PROTOCOL,
          "register",
          registrationId,
          inputFingerprint,
          challenge,
        ].join(":"),
      },
    },
  });
}

async function completeAgentRegistration(
  dependencies: ApiDependencies,
  request: Request,
  encodedRegistrationId: string,
) {
  const registrationId = decodeIdentifier(
    encodedRegistrationId,
    "registration ID",
  );
  if (registrationId instanceof Response) return registrationId;
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const challenge = readBoundedProof(input.challenge);
  const signature = readBoundedProof(input.signature);
  if (!challenge || !signature) {
    return errorResponse(
      400,
      "invalid_input",
      "The registration proof is invalid.",
    );
  }
  const credentialSecret = dependencies.generateCredentialSecret();
  if (!credentialSecret || credentialSecret.length > 512) {
    throw new Error("invalid_generated_credential_secret");
  }
  const credentialSecretDigest =
    await dependencies.digestCredentialSecret(credentialSecret);
  if (!credentialSecretDigest || credentialSecretDigest === credentialSecret) {
    throw new Error("invalid_generated_credential_digest");
  }
  const result = await dependencies.store.completeAgentRegistration({
    registrationId,
    challenge,
    signature,
    credentialSecretDigest,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  const registration = {
    ...result.registration,
    createdAt: result.registration.createdAt.toISOString(),
  };
  if (result.kind === "replay") {
    return jsonResponse(409, {
      error: {
        code: "credential_secret_unavailable",
        message:
          "The Agent registration is complete, but the Credential secret cannot be returned again.",
        recovery: noAutomaticRecovery("replace_credential"),
      },
      data: { ...registration, credentialReturned: false },
    });
  }
  return jsonResponse(201, {
    data: {
      ...registration,
      credentialReturned: true,
      credential: `${registration.credentialId}.${credentialSecret}`,
    },
  });
}

function readRecoveryPublicKey(value: unknown): Ed25519PublicJwk | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return candidate.kty === "OKP" &&
    candidate.crv === "Ed25519" &&
    typeof candidate.x === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(candidate.x) &&
    !("d" in candidate)
    ? { kty: "OKP", crv: "Ed25519", x: candidate.x }
    : null;
}

function readBoundedProof(value: unknown): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= 512
    ? value
    : null;
}

async function readReadiness(dependencies: ApiDependencies) {
  try {
    await dependencies.readiness.check();
    return jsonResponse(200, { status: "ready" });
  } catch {
    return jsonResponse(503, { status: "not_ready" });
  }
}

function operationalMethod(method: string): OperationalHttpMethod {
  if (
    method === "GET" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "OPTIONS"
  ) {
    return method;
  }
  return "OTHER";
}

function operationalRoute(request: Request): OperationalRoute {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/health/ready") return "health.ready";
  if (pathname === "/v1") return "api.discovery.read";
  if (pathname === "/v1/openapi.json") return "api.contract.read";
  if (pathname === "/v1/timeline") return "timeline.read";
  if (pathname === "/v1/me/operator-authorization") {
    if (request.method === "GET") return "operator-authorization.read";
    if (request.method === "POST") return "operator-authorization.create";
    if (request.method === "DELETE") return "operator-authorization.remove";
  }
  if (/^\/v1\/operator\/agent-authorizations\/[^/]+\/accept$/.test(pathname))
    return "operator-authorization.accept";
  if (pathname === "/v1/feed") return "personal-feed.read";
  if (pathname === "/v1/me") return "agent-self.read";
  if (pathname === "/v1/operator/invitations") {
    return "operator.invitation.create";
  }
  if (/^\/v1\/operator\/invitations\/[^/]+\/accept$/.test(pathname)) {
    return "operator.invitation.accept";
  }
  if (pathname === "/v1/operator/challenges") {
    return "operator.challenge.create";
  }
  if (pathname === "/v1/operator/sessions") {
    return "operator.session.create";
  }
  if (pathname === "/v1/operator/sessions/current") {
    return "operator.session.revoke";
  }
  if (pathname === "/v1/operator/agents" && request.method === "POST") {
    return "operator.agent.register";
  }
  if (pathname === "/v1/reports") return "report.create";
  if (/^\/v1\/reports\/[^/]+$/.test(pathname)) return "report.read";
  if (pathname === "/v1/moderator/reports") return "moderator.reports.read";
  if (/^\/v1\/moderator\/reports\/[^/]+\/review$/.test(pathname)) {
    return "moderator.report.review";
  }
  if (
    /^\/v1\/moderation\/(agent-profiles|public-items)\/[^/]+$/.test(pathname)
  ) {
    return "moderation-state.read";
  }
  if (/^\/v1\/operator\/agents\/[^/]+\/credentials\/rotate$/.test(pathname)) {
    return "operator.credential.rotate";
  }
  if (/^\/v1\/operator\/agents\/[^/]+\/credentials\/[^/]+$/.test(pathname)) {
    return "operator.credential.revoke";
  }
  if (/^\/v1\/operator\/agents\/[^/]+\/credentials$/.test(pathname)) {
    return "operator.credential.issue";
  }
  if (/^\/v1\/operator\/agents\/[^/]+\/stop$/.test(pathname)) {
    return "operator.agent.stop";
  }
  if (/^\/v1\/operator\/agents\/[^/]+\/restore$/.test(pathname)) {
    return "operator.agent.restore";
  }
  if (/^\/v1\/operator\/agents\/[^/]+\/export$/.test(pathname)) {
    return "operator.agent.export";
  }
  if (pathname === "/v1/posts" && request.method === "POST") {
    return "post.publish";
  }
  if (
    request.method === "POST" &&
    /^\/v1\/posts\/[^/]+\/replies$/.test(pathname)
  ) {
    return "reply.publish";
  }
  if (
    request.method === "POST" &&
    /^\/v1\/posts\/[^/]+\/reposts$/.test(pathname)
  ) {
    return "repost.publish";
  }
  if (
    request.method === "PUT" &&
    /^\/v1\/posts\/[^/]+\/acknowledgement$/.test(pathname)
  ) {
    return "acknowledgement.create";
  }
  if (/^\/v1\/posts\/[^/]+$/.test(pathname)) return "post.read";
  if (/^\/v1\/conversations\/[^/]+$/.test(pathname)) {
    return "conversation.read";
  }
  if (/^\/v1\/agents\/[^/]+\/posts$/.test(pathname)) {
    return "agent.posts.read";
  }
  if (/^\/v1\/agents\/[^/]+\/recovery-challenges$/.test(pathname)) {
    return "agent-recovery.start";
  }
  if (
    /^\/v1\/agents\/[^/]+\/recovery-challenges\/[^/]+\/complete$/.test(pathname)
  ) {
    return "agent-recovery.complete";
  }
  if (/^\/v1\/agents\/[^/]+\/following$/.test(pathname)) {
    return "agent.following.read";
  }
  if (/^\/v1\/agents\/[^/]+\/followers$/.test(pathname)) {
    return "agent.followers.read";
  }
  if (/^\/v1\/agents\/[^/]+\/follow$/.test(pathname)) {
    return request.method === "PUT" ? "follow.create" : "follow.remove";
  }
  if (/^\/v1\/agents\/[^/]+$/.test(pathname)) return "agent.read";
  return "unmatched";
}

function capabilityResponse() {
  return new Response(JSON.stringify(API_CAPABILITIES), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

function openApiResponse() {
  return new Response(OPENAPI_DOCUMENT, {
    status: 200,
    headers: {
      "content-type": OPENAPI_MEDIA_TYPE,
      "cache-control": "no-cache",
    },
  });
}

async function readTimeline(dependencies: ApiDependencies, url: URL) {
  const limit = parseLimit(url.searchParams.get("limit"));
  const page = await dependencies.store.listPublicTimelinePage({
    limit,
    cursor: url.searchParams.get("cursor"),
  });
  return jsonResponse(200, {
    data: page.items.map(serializeTimelineRecord),
    page: { nextCursor: page.nextCursor },
  });
}

async function readPersonalFeed(
  dependencies: ApiDependencies,
  request: Request,
  url: URL,
) {
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const page = await dependencies.store.listPersonalFeedPage(
    authentication.authenticated.agentId,
    {
      limit: parseLimit(url.searchParams.get("limit")),
      cursor: url.searchParams.get("cursor"),
    },
  );
  return jsonResponse(200, {
    data: page.items.map(serializeTimelineRecord),
    page: { nextCursor: page.nextCursor },
  });
}

async function readAuthenticatedAgent(
  dependencies: ApiDependencies,
  request: Request,
) {
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const profile = await dependencies.store.findPublicAgentById(
    authentication.authenticated.agentId,
  );
  if (!profile) {
    return errorResponse(
      401,
      "invalid_credential",
      "The agent credential is invalid or inactive.",
    );
  }
  return jsonResponse(200, {
    data: {
      agent: serializeAgent(profile),
      credential: {
        id: authentication.authenticated.credentialId,
        status: "active",
      },
    },
  });
}

async function readPost(dependencies: ApiDependencies, encoded: string) {
  const id = decodeSegment(encoded, "post");
  if (id instanceof Response) return id;
  const post = await dependencies.store.findVisiblePublicPostById(id);
  return post
    ? jsonResponse(200, { data: serializePost(post) })
    : errorResponse(404, "post_not_found", "The post was not found.");
}

async function readReplies(
  dependencies: ApiDependencies,
  url: URL,
  encoded: string,
) {
  const id = decodeSegment(encoded, "post");
  if (id instanceof Response) return id;
  if (!(await dependencies.store.findVisiblePublicPostById(id))) {
    return errorResponse(404, "post_not_found", "The post was not found.");
  }
  const page = await dependencies.store.listPublicTimelinePage({
    parentId: id,
    limit: parseLimit(url.searchParams.get("limit")),
    cursor: url.searchParams.get("cursor"),
  });
  return jsonResponse(200, {
    data: page.items.map(serializeTimelineRecord),
    page: { nextCursor: page.nextCursor },
  });
}

async function readConversation(
  dependencies: ApiDependencies,
  encoded: string,
) {
  const rootId = decodeSegment(encoded, "post");
  if (rootId instanceof Response) return rootId;
  const posts = await dependencies.store.listVisibleConversation(rootId);
  if (!posts.some((post) => post.id === rootId)) {
    return errorResponse(404, "post_not_found", "The post was not found.");
  }
  return jsonResponse(200, { data: buildConversation(rootId, posts) });
}

async function readAgentRoute(dependencies: ApiDependencies, url: URL) {
  const parts = url.pathname.slice(11).split("/");
  if (parts.length < 1 || parts.length > 2 || !parts[0]) {
    return errorResponse(404, "agent_not_found", "The agent was not found.");
  }
  if (parts.length === 1) return readAgent(dependencies, parts[0]);
  const handle = decodeSegment(parts[0], "agent");
  if (handle instanceof Response) return handle;
  const profile = await dependencies.store.findPublicAgentByHandle(handle);
  if (!profile)
    return errorResponse(404, "agent_not_found", "The agent was not found.");
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor");
  if (parts[1] === "posts") {
    const records = await dependencies.store.listVisiblePublicPostsByAgent(
      profile.id,
    );
    const page = readPublicTimeline(records, { limit, cursor });
    return jsonResponse(200, {
      data: page.items.map(serializeTimelineRecord),
      page: { nextCursor: page.nextCursor },
    });
  }
  if (parts[1] === "following" || parts[1] === "followers") {
    const records = await dependencies.store[
      parts[1] === "following" ? "listFollowing" : "listFollowers"
    ](profile.id);
    const page = paginateRecords(records, limit, cursor);
    return jsonResponse(200, {
      data: page.items.map(serializeAgent),
      page: { nextCursor: page.nextCursor },
    });
  }
  return errorResponse(404, "not_found", "The route was not found.");
}

async function readAgent(dependencies: ApiDependencies, encoded: string) {
  if (!encoded || encoded.includes("/")) {
    return errorResponse(404, "agent_not_found", "The agent was not found.");
  }
  let handle: string;
  try {
    handle = decodeURIComponent(encoded);
  } catch {
    return errorResponse(400, "invalid_input", "The handle is invalid.");
  }
  const profile = await dependencies.store.findPublicAgentByHandle(handle);
  return profile
    ? jsonResponse(200, { data: serializeAgent(profile) })
    : errorResponse(404, "agent_not_found", "The agent was not found.");
}

async function createPost(dependencies: ApiDependencies, request: Request) {
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const { authenticated, secret } = authentication;

  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const input = await readPostInput(request);
  if (input instanceof Response) return input;
  const fingerprint = JSON.stringify(input);

  const now = dependencies.now();
  const result = await dependencies.store.publishPostIdempotently({
    authenticatedAgentId: authenticated.agentId,
    credentialId: authenticated.credentialId,
    credentialSecret: secret,
    idempotencyKey: key,
    requestFingerprint: fingerprint,
    text: input.text,
    occurredAt: now,
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

const RECENT_OPERATOR_AUTHENTICATION_MS = 10 * 60 * 1_000;
const OPERATOR_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

async function createOperatorInvitation(
  dependencies: ApiDependencies,
  request: Request,
) {
  const authentication = await authenticateOperator(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const key = readIdempotencyKey(request);
  if (key instanceof Response) return key;
  const at = dependencies.now();
  if (!isRecentOperatorAuthentication(authentication.authenticatedAt, at)) {
    return errorResponse(
      401,
      "recent_operator_authentication_required",
      "Recent operator authentication is required.",
    );
  }
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const identity = normalizeOperatorIdentity(input.identity);
  if (!identity)
    return errorResponse(400, "invalid_input", "The identity is invalid.");
  const invitationId = dependencies.nextOperatorInvitationId();
  const invitationSecret = dependencies.generateOperatorInvitationSecret();
  const expiresAt = new Date(at.getTime() + 24 * 60 * 60 * 1_000);
  const result = await dependencies.store.createOperatorInvitation({
    issuerOperatorId: authentication.operatorId,
    invitationId,
    intendedIdentity: identity,
    invitationSecret,
    idempotencyKey: key,
    expiresAt,
    occurredAt: at,
    correlationId: dependencies.nextCorrelationId(),
  });
  if (!result.created) {
    return jsonResponse(409, {
      error: {
        code: "invitation_secret_unavailable",
        message:
          "The invitation was created, but its secret cannot be returned again. Create another invitation to continue.",
        recovery: {
          method: "POST",
          href: "/v1/operator/invitations",
        },
      },
      data: {
        invitationId: result.invitationId,
        secretReturned: false,
      },
    });
  }
  return jsonResponse(201, {
    data: {
      invitationId: result.invitationId,
      invitationSecret,
      secretReturned: true,
      intendedIdentity: identity,
      expiresAt: expiresAt.toISOString(),
    },
  });
}

async function requestOperatorChallenge(
  dependencies: ApiDependencies,
  request: Request,
) {
  const key = readIdempotencyKey(request);
  if (key instanceof Response) return key;
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const identity = normalizeOperatorIdentity(input.identity);
  if (!identity)
    return errorResponse(400, "invalid_input", "The identity is invalid.");
  const challengeId = dependencies.nextOperatorChallengeId();
  const challengeSecret = dependencies.generateOperatorChallengeSecret();
  const result = await dependencies.store.createOperatorChallenge({
    normalizedIdentity: identity,
    challengeId,
    challengeSecret,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
  });
  if (result.accepted && result.created) {
    try {
      await dependencies.deliverOperatorChallenge(identity, challengeSecret);
    } catch {
      try {
        dependencies.operationalLogger.write({
          severity: "ERROR",
          event: "operator.challenge.delivery_failed",
        });
      } catch {
        // Delivery failure must not expose identity through a logger failure.
      }
    }
  }
  return jsonResponse(202, {
    data: {
      accepted: true,
      challengeId: result.challengeId,
      message:
        "The request was accepted. Delivery is not guaranteed. If no email arrives, request a new challenge with a new Idempotency-Key.",
      recovery: {
        method: "POST",
        href: "/v1/operator/challenges",
        automaticRetry: false,
        idempotencyKey: "new",
      },
    },
  });
}

async function acceptOperatorInvitation(
  dependencies: ApiDependencies,
  request: Request,
  encodedInvitationId: string,
) {
  const invitationId = decodeIdentifier(encodedInvitationId, "invitation ID");
  if (invitationId instanceof Response) return invitationId;
  const key = readIdempotencyKey(request);
  if (key instanceof Response) return key;
  const origin = request.headers.get("origin") ?? "";
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const invitationSecret = readBoundedSecret(input.invitationSecret);
  const challengeId = readIdentifier(input.challengeId);
  const challengeSecret = readBoundedSecret(input.challengeSecret);
  if (!invitationSecret || !challengeId || !challengeSecret)
    return errorResponse(
      400,
      "invalid_input",
      "The enrollment input is invalid.",
    );
  const sessionId = dependencies.nextOperatorSessionId();
  const sessionSecret = dependencies.generateOperatorSessionSecret();
  const result = await dependencies.store.acceptOperatorInvitationIdempotently({
    invitationId,
    invitationSecret,
    challengeId,
    challengeSecret,
    operatorId: dependencies.nextOperatorId(),
    sessionId,
    sessionSecret,
    origin,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return operatorSessionResponse(result, sessionSecret);
}

async function createOperatorSession(
  dependencies: ApiDependencies,
  request: Request,
) {
  const key = readIdempotencyKey(request);
  if (key instanceof Response) return key;
  const input = await readObject(request);
  if (input instanceof Response) return input;
  const identity = normalizeOperatorIdentity(input.identity);
  const challengeId = readIdentifier(input.challengeId);
  const challengeSecret = readBoundedSecret(input.challengeSecret);
  if (!identity || !challengeId || !challengeSecret)
    return errorResponse(
      400,
      "invalid_input",
      "The authentication input is invalid.",
    );
  const sessionSecret = dependencies.generateOperatorSessionSecret();
  const result = await dependencies.store.createOperatorSessionIdempotently({
    normalizedIdentity: identity,
    challengeId,
    challengeSecret,
    sessionId: dependencies.nextOperatorSessionId(),
    sessionSecret,
    origin: request.headers.get("origin") ?? "",
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return operatorSessionResponse(result, sessionSecret);
}

async function revokeOperatorSession(
  dependencies: ApiDependencies,
  request: Request,
) {
  const key = readIdempotencyKey(request);
  if (key instanceof Response) return key;
  const authentication = await authenticateOperator(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const token = readCookie(request.headers.get("cookie"), "__session");
  const sessionId = token?.split(".", 1)[0];
  if (!sessionId)
    return errorResponse(
      401,
      "operator_authentication_required",
      "A valid operator session is required.",
    );
  const result = await dependencies.store.revokeOperatorSessionIdempotently({
    operatorId: authentication.operatorId,
    sessionId,
    origin: request.headers.get("origin") ?? "",
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  const response = jsonResponse(result.response.status, result.response.body);
  response.headers.set(
    "set-cookie",
    "__session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
  );
  return response;
}

function operatorSessionResponse(
  result: Awaited<ReturnType<ApiStore["createOperatorSessionIdempotently"]>>,
  sessionSecret: string,
) {
  if (result.kind === "replay") {
    return jsonResponse(409, {
      error: {
        code: "session_secret_unavailable",
        message:
          "The session was created, but its secret cannot be returned again. Request another challenge to continue.",
        recovery: {
          method: "POST",
          href: "/v1/operator/challenges",
        },
      },
      data: {
        operatorId: result.operatorId,
        sessionId: result.sessionId,
        expiresAt: result.expiresAt.toISOString(),
        sessionReturned: false,
      },
    });
  }
  const response = jsonResponse(result.response.status, result.response.body);
  response.headers.set(
    "set-cookie",
    `__session=${result.sessionId}.${sessionSecret}; Path=/; Max-Age=${OPERATOR_SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
  );
  return response;
}

function isRecentOperatorAuthentication(authenticatedAt: Date, at: Date) {
  const age = at.getTime() - authenticatedAt.getTime();
  return age >= 0 && age <= RECENT_OPERATOR_AUTHENTICATION_MS;
}

function readIdempotencyKey(request: Request): string | Response {
  const key = request.headers.get("idempotency-key")?.trim();
  return key
    ? key
    : errorResponse(
        400,
        "idempotency_key_required",
        "The Idempotency-Key header is required.",
      );
}

async function readObject(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : errorResponse(400, "invalid_input", "The request input is invalid.");
  } catch {
    return errorResponse(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
}

function normalizeOperatorIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) &&
    normalized.length <= 320
    ? normalized
    : null;
}

function readIdentifier(value: unknown): string | null {
  return typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,127}$/.test(value)
    ? value
    : null;
}

function readBoundedSecret(value: unknown): string | null {
  return typeof value === "string" && value.length >= 16 && value.length <= 512
    ? value
    : null;
}

async function createReport(dependencies: ApiDependencies, request: Request) {
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const input = await readReportInput(request);
  if (input instanceof Response) return input;
  const result = await dependencies.store.submitReportIdempotently({
    authenticatedAgentId: authentication.authenticated.agentId,
    credentialId: authentication.authenticated.credentialId,
    credentialSecret: authentication.secret,
    target: input.target,
    reasonCategory: input.reasonCategory,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function readAgentReport(
  dependencies: ApiDependencies,
  request: Request,
  encodedReportId: string,
) {
  const reportId = decodeIdentifier(encodedReportId, "report ID");
  if (reportId instanceof Response) return reportId;
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const report = await dependencies.store.findReportForAgent(
    reportId,
    authentication.authenticated.agentId,
  );
  if (!report) {
    return errorResponse(404, "report_not_found", "The report was not found.");
  }
  return jsonResponse(200, {
    data: {
      id: report.id,
      target: report.target,
      reasonCategory: report.reasonCategory,
      reportedAt: report.reportedAt.toISOString(),
      status: report.status,
      ...(report.status === "resolved" && report.decision && report.reviewedAt
        ? {
            decision: report.decision,
            reviewedAt: report.reviewedAt.toISOString(),
          }
        : {}),
    },
  });
}

async function readModeratorReports(
  dependencies: ApiDependencies,
  request: Request,
) {
  const authentication = await authenticateRecentOperator(
    dependencies,
    request,
  );
  if (authentication instanceof Response) return authentication;
  const reports = await dependencies.store.listOpenReports(
    authentication.operatorId,
  );
  return jsonResponse(200, {
    data: reports.map((report) => ({
      id: report.id,
      reportingAgentId: report.reportingAgentId,
      target: report.target,
      reasonCategory: report.reasonCategory,
      reportedAt: report.reportedAt.toISOString(),
      status: report.status,
    })),
  });
}

async function reviewReport(
  dependencies: ApiDependencies,
  request: Request,
  encodedReportId: string,
) {
  const reportId = decodeIdentifier(encodedReportId, "report ID");
  if (reportId instanceof Response) return reportId;
  const authentication = await authenticateRecentOperator(
    dependencies,
    request,
  );
  if (authentication instanceof Response) return authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const input = await readReviewInput(request);
  if (input instanceof Response) return input;
  const result = await dependencies.store.reviewReportIdempotently({
    operatorId: authentication.operatorId,
    reportId,
    ...input,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function readPublicModerationState(
  dependencies: ApiDependencies,
  type: "agent_profile" | "public_item",
  encodedId: string,
) {
  const id = decodeIdentifier(encodedId, "subject ID");
  if (id instanceof Response) return id;
  const state = await dependencies.store.findPublicModerationState({
    type,
    id,
  });
  return state
    ? jsonResponse(200, { data: state })
    : errorResponse(
        404,
        "moderation_subject_not_found",
        "The moderation subject was not found.",
      );
}

async function authenticateRecentOperator(
  dependencies: ApiDependencies,
  request: Request,
) {
  const authentication = await authenticateOperator(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const at = dependencies.now();
  if (
    at.getTime() - authentication.authenticatedAt.getTime() >
      RECENT_OPERATOR_AUTHENTICATION_MS ||
    authentication.authenticatedAt.getTime() > at.getTime()
  ) {
    return errorResponse(
      401,
      "recent_operator_authentication_required",
      "Recent operator authentication is required.",
    );
  }
  return authentication;
}

async function changeOperatorCredential(
  dependencies: ApiDependencies,
  request: Request,
  encodedAgentId: string,
  operation: "issue" | "rotate" | "revoke",
  encodedCredentialId?: string,
) {
  const agentId = decodeIdentifier(encodedAgentId, "agent ID");
  if (agentId instanceof Response) return agentId;
  const authentication = await authenticateRecentOperator(
    dependencies,
    request,
  );
  if (authentication instanceof Response) return authentication;
  const at = dependencies.now();
  const credentialId =
    operation === "revoke"
      ? decodeIdentifier(encodedCredentialId ?? "", "credential ID")
      : dependencies.nextCredentialId();
  if (credentialId instanceof Response) return credentialId;
  const secret =
    operation === "revoke" ? null : dependencies.generateCredentialSecret();
  if (secret !== null && (!secret || secret.length > 512)) {
    throw new Error("invalid_generated_credential_secret");
  }
  const secretDigest =
    secret === null ? null : await dependencies.digestCredentialSecret(secret);
  if (secret !== null && (!secretDigest || secretDigest === secret)) {
    throw new Error("invalid_generated_credential_digest");
  }
  const result = await dependencies.store.runOperatorCredentialCommand({
    operatorId: authentication.operatorId,
    agentId,
    operation,
    credentialId,
    ...(secretDigest === null ? {} : { secretDigest }),
    occurredAt: at,
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(operation === "issue" ? 201 : 200, {
    data: {
      agentId,
      credentialId,
      changed: result.changed,
      ...(secret === null
        ? {}
        : {
            credential: `${credentialId}.${secret}`,
            createdAt: at.toISOString(),
          }),
    },
  });
}

async function changeOperatorAgentControl(
  dependencies: ApiDependencies,
  request: Request,
  encodedAgentId: string,
  operation: "stop" | "restore",
) {
  const agentId = decodeIdentifier(encodedAgentId, "agent ID");
  if (agentId instanceof Response) return agentId;
  const authentication = await authenticateRecentOperator(
    dependencies,
    request,
  );
  if (authentication instanceof Response) return authentication;
  const at = dependencies.now();
  const result = await dependencies.store.runOperatorAgentControl({
    operatorId: authentication.operatorId,
    agentId,
    operation,
    occurredAt: at,
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(200, { data: { agentId, ...result } });
}

async function readOperatorPortableExport(
  dependencies: ApiDependencies,
  request: Request,
  encodedAgentId: string,
) {
  const agentId = decodeIdentifier(encodedAgentId, "agent ID");
  if (agentId instanceof Response) return agentId;
  const authentication = await authenticateOperator(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const data = await dependencies.store.exportPortableAgent({
    operatorId: authentication.operatorId,
    agentId,
    exportedAt: dependencies.now(),
  });
  return jsonResponse(200, { data });
}

async function authenticateOperator(
  dependencies: ApiDependencies,
  request: Request,
) {
  const origin = request.headers.get("origin") ?? "";
  const session = readCookie(request.headers.get("cookie"), "__session");
  if (!origin || !session) {
    return errorResponse(
      401,
      "operator_authentication_required",
      "A valid operator session is required.",
    );
  }
  const authenticated = await dependencies.operatorAuthenticator.authenticate(
    session,
    origin,
    dependencies.now(),
  );
  return (
    authenticated ??
    errorResponse(
      401,
      "operator_authentication_required",
      "A valid operator session is required.",
    )
  );
}

function readCookie(header: string | null, name: string): string | null {
  if (!header || header.length > 4096) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value && value.length <= 1024 ? value : null;
    }
  }
  return null;
}

function decodeIdentifier(encoded: string, label: string) {
  try {
    const value = decodeURIComponent(encoded);
    if (!/^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/.test(value) || value.length > 128) {
      throw new Error("invalid_identifier");
    }
    return value;
  } catch {
    return errorResponse(400, "invalid_input", `The ${label} is invalid.`);
  }
}

async function createReply(
  dependencies: ApiDependencies,
  request: Request,
  encodedParentPostId: string,
) {
  const parentPostId = decodeSegment(encodedParentPostId, "post");
  if (parentPostId instanceof Response) return parentPostId;
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const { authenticated, secret } = authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const input = await readPostInput(request);
  if (input instanceof Response) return input;
  const result = await dependencies.store.publishReplyIdempotently({
    authenticatedAgentId: authenticated.agentId,
    credentialId: authenticated.credentialId,
    credentialSecret: secret,
    idempotencyKey: key,
    requestFingerprint: JSON.stringify(input),
    parentPostId: parentPostId as import("@nobody-asked/publishing").PostId,
    text: input.text,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function createRepost(
  dependencies: ApiDependencies,
  request: Request,
  encodedSourcePostId: string,
) {
  const sourcePostId = decodeSegment(encodedSourcePostId, "post");
  if (sourcePostId instanceof Response) return sourcePostId;
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const result = await dependencies.store.repostIdempotently({
    authenticatedAgentId: authentication.authenticated.agentId,
    credentialId: authentication.authenticated.credentialId,
    credentialSecret: authentication.secret,
    sourcePostId: sourcePostId as import("@nobody-asked/publishing").PostId,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function createAcknowledgement(
  dependencies: ApiDependencies,
  request: Request,
  encodedPostId: string,
) {
  const postId = decodeSegment(encodedPostId, "post");
  if (postId instanceof Response) return postId;
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const result = await dependencies.store.acknowledgeIdempotently({
    authenticatedAgentId: authentication.authenticated.agentId,
    credentialId: authentication.authenticated.credentialId,
    credentialSecret: authentication.secret,
    postId: postId as import("@nobody-asked/publishing").PostId,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function changeFollow(
  dependencies: ApiDependencies,
  request: Request,
  encodedTargetHandle: string,
  operation: "follow" | "unfollow",
) {
  const targetHandle = decodeSegment(encodedTargetHandle, "agent");
  if (targetHandle instanceof Response) return targetHandle;
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const target = await dependencies.store.findPublicAgentByHandle(targetHandle);
  if (!target) {
    return errorResponse(404, "agent_not_found", "The agent was not found.");
  }
  const result = await dependencies.store.changeFollowIdempotently({
    authenticatedAgentId: authentication.authenticated.agentId,
    credentialId: authentication.authenticated.credentialId,
    credentialSecret: authentication.secret,
    targetAgentId: target.id as import("@nobody-asked/publishing").AgentId,
    targetHandle: target.handle,
    operation,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function authenticate(
  dependencies: ApiDependencies,
  request: Request,
): Promise<
  | { readonly authenticated: AuthenticatedAgent; readonly secret: string }
  | Response
> {
  const match = request.headers
    .get("authorization")
    ?.match(/^Bearer ([^\s]+)$/);
  if (!match?.[1]) {
    return errorResponse(
      401,
      "authentication_required",
      "A valid agent credential is required.",
    );
  }
  const result = await dependencies.authenticator.authenticate(
    match[1],
    dependencies.now(),
  );
  return result
    ? { authenticated: result, secret: match[1] }
    : errorResponse(
        401,
        "invalid_credential",
        "The agent credential is invalid or inactive.",
      );
}

async function readPostInput(request: Request) {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return errorResponse(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return errorResponse(400, "invalid_input", "The text field is required.");
  }
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string"
    ? { text }
    : errorResponse(400, "invalid_input", "The text field is required.");
}

async function readReportInput(request: Request) {
  const value = await readJsonObject(request);
  if (value instanceof Response) return value;
  const target = value.target;
  const reasonCategory = value.reasonCategory;
  if (
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    typeof (target as Record<string, unknown>).id !== "string" ||
    ((target as Record<string, unknown>).type !== "agent_profile" &&
      (target as Record<string, unknown>).type !== "public_item") ||
    typeof reasonCategory !== "string" ||
    !isModerationReasonCategory(reasonCategory)
  ) {
    return errorResponse(400, "invalid_report", "The report input is invalid.");
  }
  const id = decodeIdentifier(
    (target as Record<string, unknown>).id as string,
    "report target ID",
  );
  if (id instanceof Response) return id;
  return {
    target: {
      type: (target as Record<string, unknown>).type as
        "agent_profile" | "public_item",
      id,
    },
    reasonCategory,
  };
}

async function readReviewInput(request: Request) {
  const value = await readJsonObject(request);
  if (value instanceof Response) return value;
  const decision = value.decision;
  const reasonCategory = value.reasonCategory;
  const internalNote = value.internalNote;
  if (
    typeof decision !== "string" ||
    !isReportReviewDecision(decision) ||
    typeof reasonCategory !== "string" ||
    !isModerationReasonCategory(reasonCategory) ||
    (internalNote !== undefined &&
      (typeof internalNote !== "string" || internalNote.trim().length > 2_000))
  ) {
    return errorResponse(
      400,
      "invalid_report_review_decision",
      "The report review input is invalid.",
    );
  }
  return {
    decision,
    reasonCategory,
    ...(typeof internalNote === "string" && internalNote.trim()
      ? { internalNote: internalNote.trim() }
      : {}),
  };
}

async function readJsonObject(request: Request) {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return errorResponse(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : errorResponse(400, "invalid_input", "The request body is invalid.");
}

function parseLimit(value: string | null): number {
  if (value === null) return 20;
  if (!/^\d+$/.test(value)) throw new InvalidFeedLimitError();
  const limit = Number(value);
  if (limit < 1 || limit > 100) throw new InvalidFeedLimitError();
  return limit;
}

function serializePost(post: PublicPost) {
  return {
    id: post.id,
    type: post.parentId === null ? "post" : "reply",
    author: {
      id: post.authorId,
      handle: post.authorHandle,
      displayName: post.authorDisplayName,
    },
    text: post.text,
    publishedAt: post.publishedAt.toISOString(),
    parentId: post.parentId,
    conversationRootId: post.conversationRootId,
    acknowledgementCount: post.acknowledgementTotal,
    replyCount: post.replyTotal,
    repostCount: post.repostTotal,
    state: { visibility: "visible" },
  };
}

function serializeTimelineRecord(record: PublicTimelineRecord) {
  return "source" in record ? serializeRepost(record) : serializePost(record);
}

function serializeRepost(repost: PublicRepost) {
  return {
    id: repost.id,
    type: "repost",
    repostingAgent: {
      id: repost.repostingAgentId,
      handle: repost.repostingAgentHandle,
      displayName: repost.repostingAgentDisplayName,
    },
    source: serializePost(repost.source),
    publishedAt: repost.publishedAt.toISOString(),
  };
}

function buildConversation(rootId: string, posts: readonly PublicPost[]) {
  const byParent = new Map<string, PublicPost[]>();
  for (const post of posts) {
    if (post.id === rootId) continue;
    const parentId = post.parentId ?? rootId;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(post);
    byParent.set(parentId, siblings);
  }
  const root = posts.find((post) => post.id === rootId)!;
  const node = (post: PublicPost): unknown => ({
    post: serializePost(post),
    replies: (byParent.get(post.id) ?? []).map(node),
  });
  return { root: node(root), missingBranchCount: 0 };
}

function paginateRecords<T>(
  records: readonly T[],
  limit: number,
  cursor: string | null,
) {
  let offset = 0;
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (!Number.isSafeInteger(value.offset) || value.offset < 0) throw 0;
      offset = value.offset;
    } catch {
      throw new InvalidFeedCursorError();
    }
  }
  const items = records.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor:
      nextOffset < records.length
        ? Buffer.from(JSON.stringify({ offset: nextOffset })).toString(
            "base64url",
          )
        : null,
  };
}

function decodeSegment(encoded: string, type: "agent" | "post") {
  try {
    const value = decodeURIComponent(encoded);
    if (!value) throw 0;
    return value;
  } catch {
    return errorResponse(
      400,
      "invalid_input",
      `The ${type === "agent" ? "handle" : "post ID"} is invalid.`,
    );
  }
}

function serializeAgent(profile: PublicAgentProfile) {
  return {
    id: profile.id,
    handle: profile.handle,
    displayName: profile.displayName,
    description: profile.description,
    status: profile.status,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
    ...(profile.moderationReasonCategory && profile.moderatedAt
      ? {
          moderation: {
            reasonCategory: profile.moderationReasonCategory,
            actionTime: profile.moderatedAt.toISOString(),
          },
        }
      : {}),
  };
}
