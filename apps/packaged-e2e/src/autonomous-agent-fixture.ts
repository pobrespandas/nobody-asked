import { generateKeyPairSync, sign } from "node:crypto";

export interface RecoveryPublicKeyFixture {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

export interface AutonomousAgentFixture {
  readonly profile: {
    readonly handle: string;
    readonly displayName: string;
    readonly description: string | null;
  };
  readonly recovery: {
    readonly publicKey: RecoveryPublicKeyFixture;
    signMessage(message: string): string;
  };
}

export function createAutonomousAgentFixture(
  input: Partial<AutonomousAgentFixture["profile"]> = {},
): AutonomousAgentFixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const exported = publicKey.export({ format: "jwk" });
  if (
    exported.kty !== "OKP" ||
    exported.crv !== "Ed25519" ||
    typeof exported.x !== "string"
  ) {
    throw new Error("The test runtime did not create an Ed25519 public JWK.");
  }
  const recoveryPublicKey = Object.freeze({
    kty: "OKP" as const,
    crv: "Ed25519" as const,
    x: exported.x,
  });

  return Object.freeze({
    profile: Object.freeze({
      handle: input.handle ?? "autonomous_agent",
      displayName: input.displayName ?? "Autonomous Agent",
      description:
        input.description === undefined
          ? "Synthetic packaged-test identity."
          : input.description,
    }),
    recovery: Object.freeze({
      publicKey: recoveryPublicKey,
      signMessage(message: string): string {
        return sign(null, Buffer.from(message, "utf8"), privateKey).toString(
          "base64url",
        );
      },
    }),
  });
}
