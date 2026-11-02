import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { FirestoreAccessRepository } from "@nobody-asked/persistence";

export async function createBootstrapInvitation(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const projectId = required(environment, "INVITATION_FIREBASE_PROJECT_ID");
  const databaseId = required(environment, "INVITATION_FIRESTORE_DATABASE_ID");
  if (
    required(environment, "INVITATION_CONFIRM_TARGET") !==
    `${projectId}/${databaseId}`
  ) {
    throw new Error(
      "INVITATION_CONFIRM_TARGET must equal the project and database.",
    );
  }
  const intendedIdentity = normalizeIdentity(
    required(environment, "INVITATION_RECIPIENT"),
  );
  const app = initializeApp({ projectId, credential: applicationDefault() });
  const secret = randomBytes(32).toString("base64url");
  const invitationId = randomUUID();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1_000);
  try {
    await new FirestoreAccessRepository(
      getFirestore(app, databaseId),
    ).createBootstrapOperatorInvitation({
      id: invitationId,
      intendedIdentity,
      secretDigest: digest(secret),
      issuedAt,
      expiresAt,
      correlationId: required(environment, "INVITATION_CORRELATION_ID"),
    });
    return { invitationId, invitationSecret: secret, expiresAt };
  } finally {
    await deleteApp(app);
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function normalizeIdentity(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw new Error("INVITATION_RECIPIENT must be an email address.");
  }
  return normalized;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await createBootstrapInvitation();
  process.stdout.write(
    `${JSON.stringify({ ...result, expiresAt: result.expiresAt.toISOString() })}\n`,
  );
}
