import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import {
  asRecord,
  assertResponseMatchesContract,
} from "./contract-assertions.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function verifyOperatorSessionRecovery(input: {
  firestore: Firestore;
  baseUrl: URL;
  contract: Record<string, unknown>;
  operatorId: string;
  priorCookie: string;
}): Promise<string> {
  const origin = "https://operator.example";
  const identity = "new-operator@example.test";
  const challengeSecret = "packaged-recovery-challenge-secret";
  const challengeId = "packaged-recovery-challenge";
  const challenges = input.firestore.collection("operatorChallenges");
  await challenges.doc(challengeId).set({
    normalizedIdentity: identity,
    secretDigest: createHash("sha256").update(challengeSecret).digest("hex"),
    expiresAt: Timestamp.fromMillis(Date.now() + 60_000),
    consumedAt: null,
  });
  const countSessions = async () =>
    (
      await input.firestore
        .collection("operatorSessions")
        .where("operatorId", "==", input.operatorId)
        .get()
    ).size;
  const initialSessions = await countSessions();
  const authenticate = async (id: string, key: string) => {
    const response = await fetch(
      new URL("v1/operator/sessions", input.baseUrl),
      {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          origin,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({ identity, challengeId: id, challengeSecret }),
      },
    );
    const result = {
      status: response.status,
      body: (await response.json()) as unknown,
    };
    assertResponseMatchesContract(
      input.contract,
      "/v1/operator/sessions",
      "post",
      result,
    );
    return { ...result, cookie: response.headers.get("set-cookie") };
  };
  const probe = async (cookie: string) => {
    const response = await fetch(
      new URL("v1/moderator/reports", input.baseUrl),
      { headers: { origin, cookie }, signal: AbortSignal.timeout(15_000) },
    );
    return { status: response.status, body: asRecord(await response.json()) };
  };
  const before = await probe(input.priorCookie);
  assert(
    before.status === 403 &&
      asRecord(before.body.error).code === "moderator_authority_denied",
    "The enrolled session was not usable before recovery.",
  );
  const recovered = await authenticate(
    challengeId,
    "packaged-operator-recovery",
  );
  assert(
    recovered.status === 201 && recovered.cookie?.includes("HttpOnly"),
    "Operator recovery did not create a hardened session.",
  );
  assert(
    asRecord(asRecord(recovered.body).data).operatorId === input.operatorId,
    "Recovery changed Operator identity.",
  );
  assert(
    recovered.cookie !== input.priorCookie,
    "Recovery reused the old session cookie.",
  );
  const oldSession = await probe(input.priorCookie);
  assert(
    oldSession.status === 401 &&
      asRecord(oldSession.body.error).code ===
        "operator_authentication_required",
    "Recovery did not reject the previous session over HTTP.",
  );
  const currentSession = await probe(recovered.cookie!);
  assert(
    currentSession.status === 403 &&
      asRecord(currentSession.body.error).code === "moderator_authority_denied",
    "The replacement session was unusable or granted Moderator authority.",
  );
  assert(
    (await countSessions()) === initialSessions + 1,
    "Recovery did not create exactly one session.",
  );

  const replay = await authenticate(challengeId, "packaged-operator-recovery");
  assert(
    replay.status === 409 &&
      asRecord(asRecord(replay.body).error).code ===
        "session_secret_unavailable" &&
      replay.cookie === null,
    "Recovery replay returned another session secret.",
  );
  const consumed = await authenticate(challengeId, "packaged-consumed-proof");
  assert(
    consumed.status === 401 &&
      asRecord(asRecord(consumed.body).error).code ===
        "operator_authentication_rejected" &&
      consumed.cookie === null,
    "Consumed proof created another session.",
  );
  assert(
    (await countSessions()) === initialSessions + 1,
    "Replayed proof changed the session count.",
  );

  const expiredId = "packaged-expired-recovery-challenge";
  await challenges.doc(expiredId).set({
    normalizedIdentity: identity,
    secretDigest: createHash("sha256").update(challengeSecret).digest("hex"),
    expiresAt: Timestamp.fromMillis(Date.now() - 1_000),
    consumedAt: null,
  });
  const expired = await authenticate(expiredId, "packaged-expired-proof");
  assert(
    expired.status === 401 &&
      asRecord(asRecord(expired.body).error).code ===
        "operator_authentication_rejected" &&
      expired.cookie === null,
    "Expired proof created a session over HTTP.",
  );
  assert(
    (await countSessions()) === initialSessions + 1 &&
      (await challenges.doc(expiredId).get()).data()?.consumedAt === null,
    "Expired proof changed persistent session state.",
  );
  assert(
    (await probe(recovered.cookie!)).status === 403,
    "Rejected proofs revoked the valid replacement session.",
  );
  return recovered.cookie!;
}
