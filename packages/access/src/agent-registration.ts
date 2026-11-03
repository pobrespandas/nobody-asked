import { createHash, createPublicKey, verify } from "node:crypto";

export const AGENT_PROOF_LIFETIME_MS = 10 * 60 * 1_000;
export const AGENT_PROOF_PROTOCOL = "nobody-asked-agent-proof-v1";

export interface Ed25519PublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

export interface AgentRegistrationAttempt {
  readonly id: string;
  readonly inputFingerprint: string;
  readonly recoveryPublicKey: Ed25519PublicJwk;
  readonly challenge: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export type AgentRecoveryOperation =
  | "replace_credential"
  | "replace_recovery_key"
  | "stop_agent"
  | "remove_operator_authorization";

export interface AgentRecoveryChallenge {
  readonly id: string;
  readonly agentId: string;
  readonly operation: AgentRecoveryOperation;
  readonly inputFingerprint: string;
  readonly challenge: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export class InvalidAgentRecoveryKeyError extends Error {
  readonly code = "invalid_agent_recovery_key";

  constructor() {
    super("The Recovery key must be a public Ed25519 JWK.");
  }
}

export class AgentProofRejectedError extends Error {
  readonly code = "agent_proof_rejected";

  constructor() {
    super("The Agent proof was rejected.");
  }
}

export function createAgentRegistrationAttempt(input: {
  readonly id: string;
  readonly inputFingerprint: string;
  readonly recoveryPublicKey: Ed25519PublicJwk;
  readonly challenge: string;
  readonly createdAt: Date;
}): AgentRegistrationAttempt {
  assertProofComponent(input.id);
  assertProofComponent(input.inputFingerprint);
  assertProofComponent(input.challenge);
  assertEd25519PublicJwk(input.recoveryPublicKey);

  return Object.freeze({
    ...input,
    recoveryPublicKey: freezePublicKey(input.recoveryPublicKey),
    createdAt: new Date(input.createdAt),
    expiresAt: new Date(input.createdAt.getTime() + AGENT_PROOF_LIFETIME_MS),
    consumedAt: null,
  });
}

export function createAgentRecoveryChallenge(input: {
  readonly id: string;
  readonly agentId: string;
  readonly operation: AgentRecoveryOperation;
  readonly inputFingerprint: string;
  readonly challenge: string;
  readonly createdAt: Date;
}): AgentRecoveryChallenge {
  assertProofComponent(input.id);
  assertProofComponent(input.agentId);
  assertProofComponent(input.challenge);
  assertProofComponent(input.inputFingerprint);

  return Object.freeze({
    ...input,
    createdAt: new Date(input.createdAt),
    expiresAt: new Date(input.createdAt.getTime() + AGENT_PROOF_LIFETIME_MS),
    consumedAt: null,
  });
}

export function validateAgentRecoveryKey(
  value: Ed25519PublicJwk,
): Ed25519PublicJwk {
  assertEd25519PublicJwk(value);
  return freezePublicKey(value);
}

export function agentRecoveryInputFingerprint(
  operation: AgentRecoveryOperation,
  recoveryPublicKey?: Ed25519PublicJwk,
  authorizationRevision?: number,
): string {
  if (operation === "remove_operator_authorization") {
    if (
      !Number.isSafeInteger(authorizationRevision) ||
      Number(authorizationRevision) < 0
    )
      throw new AgentProofRejectedError();
    return createHash("sha256")
      .update(JSON.stringify({ operation, authorizationRevision }))
      .digest("base64url");
  }
  const key =
    operation === "replace_recovery_key"
      ? validateAgentRecoveryKey(recoveryPublicKey as Ed25519PublicJwk)
      : null;
  return createHash("sha256")
    .update(JSON.stringify({ operation, recoveryPublicKey: key }))
    .digest("base64url");
}

export function consumeAgentRegistration(input: {
  readonly attempt: AgentRegistrationAttempt;
  readonly signature: string;
  readonly at: Date;
}): AgentRegistrationAttempt {
  assertProofAvailable(input.attempt, input.at);
  assertSignature(
    input.attempt.recoveryPublicKey,
    registrationProofMessage(input.attempt),
    input.signature,
  );
  return Object.freeze({
    ...input.attempt,
    consumedAt: new Date(input.at),
  });
}

export function consumeAgentRecovery(input: {
  readonly recoveryPublicKey: Ed25519PublicJwk;
  readonly challenge: AgentRecoveryChallenge;
  readonly signature: string;
  readonly at: Date;
}): AgentRecoveryChallenge {
  assertEd25519PublicJwk(input.recoveryPublicKey);
  assertProofAvailable(input.challenge, input.at);
  assertSignature(
    input.recoveryPublicKey,
    recoveryProofMessage(input.challenge),
    input.signature,
  );
  return Object.freeze({
    ...input.challenge,
    consumedAt: new Date(input.at),
  });
}

export function registrationProofMessage(
  attempt: AgentRegistrationAttempt,
): string {
  return [
    AGENT_PROOF_PROTOCOL,
    "register",
    attempt.id,
    attempt.inputFingerprint,
    attempt.challenge,
  ].join(":");
}

export function recoveryProofMessage(
  challenge: AgentRecoveryChallenge,
): string {
  return [
    AGENT_PROOF_PROTOCOL,
    challenge.operation,
    challenge.agentId,
    challenge.id,
    challenge.inputFingerprint,
    challenge.challenge,
  ].join(":");
}

function assertEd25519PublicJwk(value: Ed25519PublicJwk): void {
  try {
    if (
      value.kty !== "OKP" ||
      value.crv !== "Ed25519" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.x) ||
      "d" in value
    ) {
      throw new Error("invalid_key");
    }
    createPublicKey({ key: value, format: "jwk" });
  } catch {
    throw new InvalidAgentRecoveryKeyError();
  }
}

function assertProofAvailable(
  value: { readonly expiresAt: Date; readonly consumedAt: Date | null },
  at: Date,
): void {
  if (value.consumedAt !== null || value.expiresAt.getTime() <= at.getTime()) {
    throw new AgentProofRejectedError();
  }
}

function assertSignature(
  publicKey: Ed25519PublicJwk,
  message: string,
  encodedSignature: string,
): void {
  try {
    const signature = Buffer.from(encodedSignature, "base64url");
    if (
      signature.length !== 64 ||
      !verify(
        null,
        Buffer.from(message, "utf8"),
        createPublicKey({ key: publicKey, format: "jwk" }),
        signature,
      )
    ) {
      throw new Error("invalid_signature");
    }
  } catch {
    throw new AgentProofRejectedError();
  }
}

function assertProofComponent(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError("A proof field must use a safe opaque identifier.");
  }
}

function freezePublicKey(value: Ed25519PublicJwk): Ed25519PublicJwk {
  return Object.freeze({ kty: "OKP", crv: "Ed25519", x: value.x });
}
