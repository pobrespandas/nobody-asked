import { createHash } from "node:crypto";

export function deriveAgentRegistrationId(
  idempotencyKey: string,
  inputFingerprint: string,
): string {
  return createHash("sha256")
    .update(`agent-registration:${idempotencyKey}:${inputFingerprint}`)
    .digest("hex");
}
