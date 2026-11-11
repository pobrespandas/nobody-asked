import { createHash } from "node:crypto";
import {
  Timestamp,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import type { ProfileCaller } from "./agent-profile.js";
import {
  constantTimeEqual,
  credentialIsActive,
  parseCredentialToken,
} from "./credential-state.js";

export class PrivateAgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAt?: string,
  ) {
    super(code);
  }
}
export function privateRequire(
  condition: unknown,
  status: number,
  code: string,
): asserts condition {
  if (!condition) throw new PrivateAgentError(status, code);
}
export const privateDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Read authority inside the same transaction as private state. This does not enqueue writes. */
export async function requirePrivateAgent(
  transaction: Transaction,
  firestore: Firestore,
  digestSecret: (secret: string) => string | Promise<string>,
  caller: ProfileCaller,
): Promise<void> {
  const token = parseCredentialToken(caller.token);
  privateRequire(
    token &&
      token.credentialId === caller.credentialId &&
      !caller.credentialId.includes("/") &&
      !caller.agentId.includes("/"),
    401,
    "invalid_credential",
  );
  const digest = await digestSecret(token.secret);
  const [profile, credential, access] = await Promise.all([
    transaction.get(firestore.collection("agentProfiles").doc(caller.agentId)),
    transaction.get(
      firestore.collection("credentials").doc(caller.credentialId),
    ),
    transaction.get(firestore.collection("agentAccess").doc(caller.agentId)),
  ]);
  const data = credential.data(),
    identity = profile.data();
  privateRequire(
    profile.exists &&
      !identity?.deletedAt &&
      !identity?.deletingAt &&
      data?.agentId === caller.agentId &&
      credentialIsActive(data, caller.at) &&
      constantTimeEqual(String(data?.secretDigest ?? ""), digest) &&
      access.data()?.activeCredentialId === caller.credentialId &&
      !access.data()?.stopped,
    401,
    "invalid_credential",
  );
  privateRequire(
    identity?.status === "active",
    403,
    identity?.status === "stopped" ? "agent_stopped" : "agent_suspended",
  );
}

/** Read a rate bucket now and defer its write until every transaction read is complete. */
export async function privateRate(
  transaction: Transaction,
  firestore: Firestore,
  caller: ProfileCaller,
  operation: string,
  limit: number,
  windowMs = 60000,
): Promise<() => void> {
  const ref = firestore
    .collection("rateLimitBuckets")
    .doc(privateDigest(`private:${operation}:${caller.agentId}`));
  const snapshot = await transaction.get(ref),
    bucket = Math.floor(caller.at.getTime() / windowMs);
  const count =
    snapshot.data()?.bucket === bucket
      ? Number(snapshot.data()?.count ?? 0)
      : 0;
  if (count >= limit)
    throw new PrivateAgentError(
      429,
      "rate_limit_exceeded",
      new Date((bucket + 1) * windowMs).toISOString(),
    );
  return () =>
    transaction.set(ref, {
      agentId: caller.agentId,
      operation,
      bucket,
      count: count + 1,
      expireAt: Timestamp.fromMillis((bucket + 2) * windowMs),
    });
}
