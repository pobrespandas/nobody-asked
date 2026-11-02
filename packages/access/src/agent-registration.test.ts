import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AGENT_PROOF_LIFETIME_MS,
  AgentProofRejectedError,
  consumeAgentRecovery,
  consumeAgentRegistration,
  createAgentRecoveryChallenge,
  createAgentRegistrationAttempt,
  InvalidAgentRecoveryKeyError,
  recoveryProofMessage,
  registrationProofMessage,
  type Ed25519PublicJwk,
} from "./agent-registration.js";

const at = new Date("2026-11-02T12:00:00.000Z");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "jwk" }) as Ed25519PublicJwk;

describe("Agent registration proof", () => {
  it("consumes one live proof from the Recovery key", () => {
    const attempt = registration();
    const consumed = consumeAgentRegistration({
      attempt,
      signature: signature(registrationProofMessage(attempt)),
      at,
    });

    expect(consumed.consumedAt).toEqual(at);
    expect(consumed.expiresAt.getTime() - consumed.createdAt.getTime()).toBe(
      AGENT_PROOF_LIFETIME_MS,
    );
  });

  it.each(["expired", "consumed", "wrong-signature"])(
    "rejects an %s proof",
    (condition) => {
      const base = registration();
      const attempt =
        condition === "expired"
          ? { ...base, expiresAt: at }
          : condition === "consumed"
            ? { ...base, consumedAt: at }
            : base;
      const proof =
        condition === "wrong-signature"
          ? signature("different-message")
          : signature(registrationProofMessage(attempt));

      expect(() =>
        consumeAgentRegistration({ attempt, signature: proof, at }),
      ).toThrow(AgentProofRejectedError);
    },
  );

  it("rejects a private or unsupported Recovery key", () => {
    const privateJwk = keys.privateKey.export({ format: "jwk" });
    expect(() =>
      createAgentRegistrationAttempt({
        id: "registration-1",
        inputFingerprint: "fingerprint-1",
        recoveryPublicKey: privateJwk as Ed25519PublicJwk,
        challenge: "challenge-1",
        createdAt: at,
      }),
    ).toThrow(InvalidAgentRecoveryKeyError);
  });
});

describe("Agent recovery proof", () => {
  it("binds a proof to the Agent and requested operation", () => {
    const challenge = createAgentRecoveryChallenge({
      id: "recovery-1",
      agentId: "agent-1",
      operation: "replace_credential",
      inputFingerprint: "fingerprint-1",
      challenge: "challenge-1",
      createdAt: at,
    });

    expect(
      consumeAgentRecovery({
        recoveryPublicKey: publicKey,
        challenge,
        signature: signature(recoveryProofMessage(challenge)),
        at,
      }).consumedAt,
    ).toEqual(at);

    expect(() =>
      consumeAgentRecovery({
        recoveryPublicKey: publicKey,
        challenge: { ...challenge, operation: "stop_agent" },
        signature: signature(recoveryProofMessage(challenge)),
        at,
      }),
    ).toThrow(AgentProofRejectedError);

    expect(() =>
      consumeAgentRecovery({
        recoveryPublicKey: publicKey,
        challenge: { ...challenge, inputFingerprint: "different-fingerprint" },
        signature: signature(recoveryProofMessage(challenge)),
        at,
      }),
    ).toThrow(AgentProofRejectedError);
  });
});

function registration() {
  return createAgentRegistrationAttempt({
    id: "registration-1",
    inputFingerprint: "fingerprint-1",
    recoveryPublicKey: publicKey,
    challenge: "challenge-1",
    createdAt: new Date(at.getTime() - 1_000),
  });
}

function signature(message: string): string {
  return sign(null, Buffer.from(message, "utf8"), keys.privateKey).toString(
    "base64url",
  );
}
