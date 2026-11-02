import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const REMOTE_RECOVERY_PROJECT_ID = "gen-lang-client-0607406471";
export const REMOTE_RECOVERY_SOURCE_DATABASE_ID = "nobody-asked-dev";
export const REMOTE_RECOVERY_DATABASE_PREFIX = "nobody-asked-recovery-";

export const RECOVERY_COLLECTIONS = Object.freeze([
  "acknowledgements",
  "agentAccess",
  "agentProfiles",
  "auditRecords",
  "bootstrapControls",
  "credentials",
  "follows",
  "handleClaims",
  "idempotencyRecords",
  "moderationActions",
  "moderatorAuthorities",
  "operatorInvitations",
  "operatorSessions",
  "operators",
  "publicItems",
  "rateLimitBuckets",
  "reports",
  "safetyBlocks",
] as const);

const REQUIRED_RECOVERY_EVIDENCE = Object.freeze([
  "agentProfiles",
  "publicItems",
  "follows",
  "acknowledgements",
  "moderationActions",
  "idempotencyRecords",
  "auditRecords",
] as const);

export interface RecoveryDocument {
  readonly id: string;
  data(): unknown;
}

export interface RecoveryDatabase {
  collection(name: string): {
    get(): Promise<{ readonly docs: readonly RecoveryDocument[] }>;
  };
}

export interface RemoteRecoveryConfig {
  readonly projectId: string;
  readonly sourceDatabaseId: string;
  readonly recoveryDatabaseId: string;
}

export interface RemoteRecoverySummary {
  readonly status: "passed";
  readonly collectionCount: number;
  readonly documentCount: number;
  readonly evidenceCollections: readonly string[];
}

export class RemoteRecoveryVerificationError extends Error {
  constructor(
    readonly code:
      | "remote_recovery_opt_in_required"
      | "remote_recovery_emulator_forbidden"
      | "remote_recovery_project_mismatch"
      | "remote_recovery_source_forbidden"
      | "remote_recovery_target_forbidden"
      | "remote_recovery_collection_mismatch"
      | "remote_recovery_evidence_missing"
      | "remote_recovery_reference_invalid",
    readonly collection: string | null = null,
  ) {
    super(code);
    this.name = "RemoteRecoveryVerificationError";
  }
}

export function validateRemoteRecoveryEnvironment(
  environment: NodeJS.ProcessEnv,
): RemoteRecoveryConfig {
  if (environment.ALLOW_REMOTE_FIRESTORE_RECOVERY_VERIFY !== "1") {
    throw new RemoteRecoveryVerificationError(
      "remote_recovery_opt_in_required",
    );
  }
  if (Object.hasOwn(environment, "FIRESTORE_EMULATOR_HOST")) {
    throw new RemoteRecoveryVerificationError(
      "remote_recovery_emulator_forbidden",
    );
  }
  const projectId = environment.REMOTE_FIRESTORE_PROJECT_ID;
  const configuredProjects = [
    projectId,
    environment.GOOGLE_CLOUD_PROJECT,
    environment.GCLOUD_PROJECT,
    environment.FIREBASE_PROJECT_ID,
  ].filter((value): value is string => value !== undefined);
  if (
    projectId !== REMOTE_RECOVERY_PROJECT_ID ||
    configuredProjects.some((value) => value !== REMOTE_RECOVERY_PROJECT_ID)
  ) {
    throw new RemoteRecoveryVerificationError(
      "remote_recovery_project_mismatch",
    );
  }
  const sourceDatabaseId = environment.REMOTE_FIRESTORE_SOURCE_DATABASE_ID;
  if (sourceDatabaseId !== REMOTE_RECOVERY_SOURCE_DATABASE_ID) {
    throw new RemoteRecoveryVerificationError(
      "remote_recovery_source_forbidden",
    );
  }
  const recoveryDatabaseId = environment.REMOTE_FIRESTORE_RECOVERY_DATABASE_ID;
  if (
    !recoveryDatabaseId ||
    recoveryDatabaseId === sourceDatabaseId ||
    !recoveryDatabaseId.startsWith(REMOTE_RECOVERY_DATABASE_PREFIX) ||
    recoveryDatabaseId.length <= REMOTE_RECOVERY_DATABASE_PREFIX.length ||
    !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(recoveryDatabaseId)
  ) {
    throw new RemoteRecoveryVerificationError(
      "remote_recovery_target_forbidden",
    );
  }
  return Object.freeze({
    projectId,
    sourceDatabaseId,
    recoveryDatabaseId,
  });
}

export async function verifyRemoteRecovery(
  source: RecoveryDatabase,
  recovery: RecoveryDatabase,
): Promise<RemoteRecoverySummary> {
  const [sourceRecords, recoveryRecords] = await Promise.all([
    readRecoveryRecords(source),
    readRecoveryRecords(recovery),
  ]);
  for (const collection of RECOVERY_COLLECTIONS) {
    if (
      digestRecords(sourceRecords.get(collection) ?? []) !==
      digestRecords(recoveryRecords.get(collection) ?? [])
    ) {
      throw new RemoteRecoveryVerificationError(
        "remote_recovery_collection_mismatch",
        collection,
      );
    }
  }
  for (const collection of REQUIRED_RECOVERY_EVIDENCE) {
    if ((recoveryRecords.get(collection) ?? []).length === 0) {
      throw new RemoteRecoveryVerificationError(
        "remote_recovery_evidence_missing",
        collection,
      );
    }
  }
  validateReferences(recoveryRecords);
  return Object.freeze({
    status: "passed",
    collectionCount: RECOVERY_COLLECTIONS.length,
    documentCount: [...recoveryRecords.values()].reduce(
      (total, records) => total + records.length,
      0,
    ),
    evidenceCollections: REQUIRED_RECOVERY_EVIDENCE,
  });
}

type StoredRecord = Readonly<{ id: string; data: Record<string, unknown> }>;

async function readRecoveryRecords(
  database: RecoveryDatabase,
): Promise<Map<string, readonly StoredRecord[]>> {
  const records = new Map<string, readonly StoredRecord[]>();
  await Promise.all(
    RECOVERY_COLLECTIONS.map(async (collection) => {
      const snapshot = await database.collection(collection).get();
      records.set(
        collection,
        snapshot.docs
          .map((document) => ({
            id: document.id,
            data: asRecord(document.data()),
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      );
    }),
  );
  return records;
}

function validateReferences(records: Map<string, readonly StoredRecord[]>) {
  const profileIds = ids(records, "agentProfiles");
  const itemIds = ids(records, "publicItems");
  for (const item of records.get("publicItems") ?? []) {
    requireReference(item.data.authorId, profileIds, "publicItems");
    if (item.data.parentId !== null && item.data.parentId !== undefined) {
      requireReference(item.data.parentId, itemIds, "publicItems");
    }
    requireReference(item.data.conversationRootId, itemIds, "publicItems");
  }
  for (const follow of records.get("follows") ?? []) {
    requireReference(follow.data.followerId, profileIds, "follows");
    requireReference(follow.data.followedId, profileIds, "follows");
  }
  for (const acknowledgement of records.get("acknowledgements") ?? []) {
    requireReference(
      acknowledgement.data.agentId,
      profileIds,
      "acknowledgements",
    );
    requireReference(acknowledgement.data.postId, itemIds, "acknowledgements");
  }
  for (const moderation of records.get("moderationActions") ?? []) {
    if (moderation.data.subjectType === "public_item") {
      requireReference(moderation.data.subjectId, itemIds, "moderationActions");
    }
  }
  for (const idempotency of records.get("idempotencyRecords") ?? []) {
    requireReference(
      idempotency.data.agentId,
      profileIds,
      "idempotencyRecords",
    );
    requireString(idempotency.data.command, "idempotencyRecords");
    requireString(idempotency.data.keyHash, "idempotencyRecords");
  }
  for (const audit of records.get("auditRecords") ?? []) {
    requireString(audit.data.actorId, "auditRecords");
    requireString(audit.data.action, "auditRecords");
    requireString(audit.data.subjectId, "auditRecords");
  }
}

function ids(
  records: Map<string, readonly StoredRecord[]>,
  collection: string,
) {
  return new Set((records.get(collection) ?? []).map((record) => record.id));
}

function requireReference(
  value: unknown,
  allowed: ReadonlySet<string>,
  collection: string,
) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new RemoteRecoveryVerificationError(
      "remote_recovery_reference_invalid",
      collection,
    );
  }
}

function requireString(value: unknown, collection: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new RemoteRecoveryVerificationError(
      "remote_recovery_reference_invalid",
      collection,
    );
  }
}

function digestRecords(records: readonly StoredRecord[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(records)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Date) return { date: value.toISOString() };
  if (value instanceof Uint8Array) {
    return { bytes: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.toDate === "function") {
      return { timestamp: (candidate.toDate as () => Date)().toISOString() };
    }
    if (
      typeof candidate.latitude === "number" &&
      typeof candidate.longitude === "number"
    ) {
      return {
        geopoint: [candidate.latitude, candidate.longitude],
      };
    }
    if (typeof candidate.path === "string" && "firestore" in candidate) {
      return { reference: candidate.path };
    }
    return Object.fromEntries(
      Object.keys(candidate)
        .sort()
        .filter((key) => candidate[key] !== undefined)
        .map((key) => [key, canonicalize(candidate[key])]),
    );
  }
  throw new RemoteRecoveryVerificationError(
    "remote_recovery_reference_invalid",
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteRecoveryVerificationError(
      "remote_recovery_reference_invalid",
    );
  }
  return value as Record<string, unknown>;
}

export async function runRemoteRecoveryVerificationCli(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = validateRemoteRecoveryEnvironment(environment);
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: config.projectId,
  });
  try {
    const summary = await verifyRemoteRecovery(
      getFirestore(app, config.sourceDatabaseId) as unknown as RecoveryDatabase,
      getFirestore(
        app,
        config.recoveryDatabaseId,
      ) as unknown as RecoveryDatabase,
    );
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await deleteApp(app);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runRemoteRecoveryVerificationCli();
  } catch (error) {
    const stable =
      error instanceof RemoteRecoveryVerificationError
        ? { status: "failed", code: error.code, collection: error.collection }
        : { status: "failed", code: "remote_recovery_unexpected_error" };
    process.stderr.write(`${JSON.stringify(stable)}\n`);
    process.exitCode = 1;
  }
}
