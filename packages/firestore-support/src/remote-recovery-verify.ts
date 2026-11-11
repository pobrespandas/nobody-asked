import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

export const REMOTE_RECOVERY_PROJECT_ID = "gen-lang-client-0607406471";
export const REMOTE_RECOVERY_SOURCE_DATABASE_ID = "nobody-asked-dev";
export const REMOTE_RECOVERY_DATABASE_PREFIX = "nobody-asked-recovery-";

export const RECOVERY_COLLECTIONS = Object.freeze([
  "acknowledgements",
  "agentAccess",
  "agentProfiles",
  "agentRegistrations",
  "agentRecoveryKeys",
  "agentRecoveryChallenges",
  "agentOperatorAuthority",
  "agentOperatorAuthorizations",
  "auditRecords",
  "bootstrapControls",
  "credentials",
  "follows",
  "handleClaims",
  "idempotencyRecords",
  "moderationActions",
  "moderatorAuthorities",
  "operatorInvitations",
  "operatorChallenges",
  "operatorSessions",
  "operators",
  "publicItems",
  "rateLimitBuckets",
  "registrationControls",
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
      | "remote_recovery_baseline_invalid"
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
  return verifyRecoveredRecords(
    collectionDigests(sourceRecords),
    recoveryRecords,
  );
}

/** Inspect a restored copy without claiming parity with an unavailable source snapshot. */
export async function inspectRecoveryIntegrity(recovery: RecoveryDatabase) {
  const records = await readRecoveryRecords(recovery);
  const evidenceMissing = REQUIRED_RECOVERY_EVIDENCE.filter(
    (name) =>
      (records.get(name)?.length ?? 0) === 0 &&
      !(name === "moderationActions" && hasHostedModerationEvidence(records)),
  );
  validateReferences(records);
  return {
    status: evidenceMissing.length
      ? "evidence_incomplete"
      : "integrity_checked",
    references: "checked" as const,
    evidenceMissing,
    snapshotParity: "not_verified" as const,
    collectionCount: records.size,
    documentCount: [...records.values()].reduce(
      (total, collection) => total + collection.length,
      0,
    ),
    collectionDigests: collectionDigests(records),
  };
}

function collectionDigests(records: Map<string, readonly StoredRecord[]>) {
  return Object.fromEntries(
    RECOVERY_COLLECTIONS.map((name) => [
      name,
      digestRecords(records.get(name) ?? []),
    ]),
  );
}

function verifyRecoveredRecords(
  sourceDigests: Record<string, string>,
  recoveryRecords: Map<string, readonly StoredRecord[]>,
): RemoteRecoverySummary {
  for (const collection of RECOVERY_COLLECTIONS) {
    if (
      sourceDigests[collection] !==
      digestRecords(recoveryRecords.get(collection) ?? [])
    ) {
      throw new RemoteRecoveryVerificationError(
        "remote_recovery_collection_mismatch",
        collection,
      );
    }
  }
  validateEvidence(recoveryRecords);
  return Object.freeze({
    status: "passed",
    collectionCount: RECOVERY_COLLECTIONS.length,
    documentCount: [...recoveryRecords.values()].reduce(
      (total, records) => total + records.length,
      0,
    ),
    evidenceCollections: REQUIRED_RECOVERY_EVIDENCE.filter(
      (name) => (recoveryRecords.get(name)?.length ?? 0) > 0,
    ),
  });
}

function validateEvidence(records: Map<string, readonly StoredRecord[]>) {
  for (const collection of REQUIRED_RECOVERY_EVIDENCE) {
    if ((records.get(collection) ?? []).length === 0) {
      if (
        collection === "moderationActions" &&
        hasHostedModerationEvidence(records)
      )
        continue;
      throw new RemoteRecoveryVerificationError(
        "remote_recovery_evidence_missing",
        collection,
      );
    }
  }
  validateReferences(records);
}

// The hosted review transaction writes the hidden item and its Audit record.
// Older recovery fixtures can also have a separate moderationActions record.
function hasHostedModerationEvidence(
  records: Map<string, readonly StoredRecord[]>,
): boolean {
  const hiddenItems = new Map(
    (records.get("publicItems") ?? [])
      .filter(({ data }) => data.visibility === "hidden")
      .map(({ id, data }) => [id, data]),
  );
  return (records.get("auditRecords") ?? []).some(({ data }) => {
    if (
      data.action !== "content.hidden" ||
      data.actorType !== "moderator" ||
      data.subjectType !== "public_item" ||
      typeof data.subjectId !== "string"
    )
      return false;
    const item = hiddenItems.get(data.subjectId);
    if (!item || !data.details) return false;
    const details = asRecord(data.details);
    return (
      details.result === "completed" &&
      typeof details.correlationId === "string" &&
      details.correlationId.length > 0 &&
      typeof details.reasonCategory === "string" &&
      details.reasonCategory === item.moderationReasonCategory &&
      details.resultingState != null &&
      asRecord(details.resultingState).publicItemStatus === "hidden" &&
      item.moderatedAt instanceof Timestamp &&
      data.createdAt instanceof Timestamp &&
      item.moderatedAt.isEqual(data.createdAt)
    );
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
  const publicItems = records.get("publicItems") ?? [];
  const itemIds = ids(records, "publicItems");
  const postIds = new Set(
    publicItems
      .filter((item) => item.data.type !== "repost")
      .map((item) => item.id),
  );
  const credentialIds = ids(records, "credentials");
  const recoveryKeyIds = ids(records, "agentRecoveryKeys");
  const registrationIds = ids(records, "agentRegistrations");
  const operatorIds = ids(records, "operators");
  const authorizations = new Map(
    (records.get("agentOperatorAuthorizations") ?? []).map((value) => [
      value.id,
      value.data,
    ]),
  );
  for (const authorization of authorizations.values()) {
    requireReference(
      authorization.agentId,
      profileIds,
      "agentOperatorAuthorizations",
    );
    requireReference(
      authorization.operatorId,
      operatorIds,
      "agentOperatorAuthorizations",
    );
    requireReference(
      authorization.requesterCredentialId,
      credentialIds,
      "agentOperatorAuthorizations",
    );
    if (
      !Number.isSafeInteger(authorization.revision) ||
      Number(authorization.revision) < 1
    )
      throw new RemoteRecoveryVerificationError(
        "remote_recovery_reference_invalid",
        "agentOperatorAuthorizations",
      );
  }
  for (const authority of records.get("agentOperatorAuthority") ?? []) {
    const data = authority.data;
    requireReference(authority.id, profileIds, "agentOperatorAuthority");
    if (
      data.agentId !== authority.id ||
      !Number.isSafeInteger(data.revision) ||
      Number(data.revision) < 0
    )
      throw new RemoteRecoveryVerificationError(
        "remote_recovery_reference_invalid",
        "agentOperatorAuthority",
      );
    for (const field of [
      "pendingAuthorizationId",
      "activeAuthorizationId",
    ] as const) {
      if (data[field] == null) continue;
      const authorization = authorizations.get(String(data[field]));
      if (
        !authorization ||
        authorization.agentId !== authority.id ||
        authorization.revokedAt != null ||
        (field === "pendingAuthorizationId"
          ? authorization.acceptedAt != null ||
            authorization.revision !== data.revision ||
            data.operatorId != null ||
            data.activeAuthorizationId != null
          : authorization.acceptedAt == null ||
            authorization.operatorId !== data.operatorId ||
            data.pendingAuthorizationId != null)
      )
        throw new RemoteRecoveryVerificationError(
          "remote_recovery_reference_invalid",
          "agentOperatorAuthority",
        );
    }
    if (data.operatorId != null) {
      requireReference(data.operatorId, operatorIds, "agentOperatorAuthority");
      if (data.activeAuthorizationId == null)
        throw new RemoteRecoveryVerificationError(
          "remote_recovery_reference_invalid",
          "agentOperatorAuthority",
        );
    }
  }
  for (const key of records.get("agentRecoveryKeys") ?? []) {
    requireReference(key.id, profileIds, "agentRecoveryKeys");
  }
  for (const registration of records.get("agentRegistrations") ?? []) {
    if (registration.data.consumedAt != null) {
      requireReference(
        registration.data.agentId,
        profileIds,
        "agentRegistrations",
      );
      requireReference(
        registration.data.agentId,
        recoveryKeyIds,
        "agentRegistrations",
      );
      requireReference(
        registration.data.credentialId,
        credentialIds,
        "agentRegistrations",
      );
    }
  }
  for (const challenge of records.get("agentRecoveryChallenges") ?? []) {
    requireReference(
      challenge.data.agentId,
      profileIds,
      "agentRecoveryChallenges",
    );
    requireReference(
      challenge.data.agentId,
      recoveryKeyIds,
      "agentRecoveryChallenges",
    );
  }
  for (const control of records.get("registrationControls") ?? []) {
    if (control.data.pending === undefined) continue;
    if (!Array.isArray(control.data.pending))
      throw new RemoteRecoveryVerificationError(
        "remote_recovery_reference_invalid",
        "registrationControls",
      );
    for (const lease of control.data.pending)
      requireReference(
        asRecord(lease).id,
        registrationIds,
        "registrationControls",
      );
  }
  for (const item of publicItems) {
    requireReference(item.data.authorId, profileIds, "publicItems");
    if (item.data.type === "repost") {
      requireReference(item.data.repostingAgentId, profileIds, "publicItems");
      requireReference(item.data.sourcePostId, postIds, "publicItems");
      continue;
    }
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
    requireString(idempotency.data.command, "idempotencyRecords");
    const command = String(idempotency.data.command);
    if (command.startsWith("operator-authorization:")) {
      if (
        ![
          "operator-authorization:create",
          "operator-authorization:remove",
          "operator-authorization:accept",
        ].includes(command)
      )
        throw new RemoteRecoveryVerificationError(
          "remote_recovery_reference_invalid",
          "idempotencyRecords",
        );
      requireReference(
        idempotency.data.actorId,
        command === "operator-authorization:accept" ? operatorIds : profileIds,
        "idempotencyRecords",
      );
      requireString(idempotency.data.keyHash, "idempotencyRecords");
      requireString(idempotency.data.requestFingerprint, "idempotencyRecords");
      const response = asRecord(idempotency.data.response);
      if (
        !Number.isInteger(response.status) ||
        response.status !==
          (command === "operator-authorization:create" ? 201 : 200)
      )
        throw new RemoteRecoveryVerificationError(
          "remote_recovery_reference_invalid",
          "idempotencyRecords",
        );
      asRecord(response.body);
    } else if (/^(POST|DELETE) \/v1\/(operator|moderator)\//.test(command)) {
      requireString(
        idempotency.data.actorId ?? idempotency.data.agentId,
        "idempotencyRecords",
      );
      requireString(idempotency.data.keyHash, "idempotencyRecords");
      requireString(idempotency.data.requestFingerprint, "idempotencyRecords");
    } else {
      requireReference(
        idempotency.data.agentId,
        profileIds,
        "idempotencyRecords",
      );
      if (
        command === "POST /v1/agent-registrations/{registrationId}/complete" ||
        [
          "agent-recovery:replace_credential",
          "agent-recovery:replace_recovery_key",
          "agent-recovery:stop_agent",
          "agent-recovery:remove_operator_authorization",
        ].includes(command)
      ) {
        requireString(
          idempotency.data.requestFingerprint,
          "idempotencyRecords",
        );
      } else requireString(idempotency.data.keyHash, "idempotencyRecords");
    }
  }
  for (const bucket of records.get("rateLimitBuckets") ?? []) {
    if (
      !String(bucket.data.command ?? "").startsWith("operator_authorization.")
    )
      continue;
    const expectedKind =
      bucket.data.command === "operator_authorization.accept"
        ? "operator"
        : "agent";
    if (
      ![
        "operator_authorization.create",
        "operator_authorization.remove",
        "operator_authorization.accept",
      ].includes(String(bucket.data.command)) ||
      bucket.data.actorKind !== expectedKind
    )
      throw new RemoteRecoveryVerificationError(
        "remote_recovery_reference_invalid",
        "rateLimitBuckets",
      );
    requireReference(
      bucket.data.actorId,
      expectedKind === "operator" ? operatorIds : profileIds,
      "rateLimitBuckets",
    );
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
  if (value instanceof Timestamp) {
    return { timestamp: [value.seconds, value.nanoseconds] };
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
  const baselineFile = environment.REMOTE_FIRESTORE_RECOVERY_BASELINE;
  const snapshotTime = environment.REMOTE_FIRESTORE_BACKUP_SNAPSHOT_TIME;
  const capture = environment.REMOTE_FIRESTORE_CAPTURE_BASELINE;
  const timestampParts = snapshotTime?.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/,
  );
  const seconds = Date.parse(`${timestampParts?.[1]}Z`) / 1000;
  if (
    (capture !== undefined && capture !== "1") ||
    ((baselineFile !== undefined || snapshotTime !== undefined || capture) &&
      (!baselineFile || !timestampParts || !Number.isFinite(seconds)))
  ) {
    throw new RemoteRecoveryVerificationError(
      "remote_recovery_baseline_invalid",
    );
  }
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: config.projectId,
  });
  try {
    const source = getFirestore(app, config.sourceDatabaseId);
    const metadata = {
      formatVersion: 1,
      projectId: config.projectId,
      sourceDatabaseId: config.sourceDatabaseId,
      snapshotTime,
    };
    if (capture && baselineFile && timestampParts) {
      const readTime = new Timestamp(
        seconds,
        Number((timestampParts[2] ?? "").padEnd(9, "0")),
      );
      const records = await source.runTransaction(
        (transaction) =>
          readRecoveryRecords({
            collection: (name) => ({
              get: async () => {
                const snapshot = await transaction.get(source.collection(name));
                if (!snapshot.readTime.isEqual(readTime))
                  throw new RemoteRecoveryVerificationError(
                    "remote_recovery_baseline_invalid",
                  );
                return snapshot;
              },
            }),
          }),
        { readOnly: true, readTime },
      );
      validateEvidence(records);
      await writeFile(
        baselineFile,
        `${JSON.stringify({ ...metadata, digests: collectionDigests(records) })}\n`,
        { flag: "wx", mode: 0o600 },
      );
      process.stdout.write(
        `${JSON.stringify({ status: "baseline_captured", ...metadata })}\n`,
      );
      return;
    }
    const recovery = getFirestore(app, config.recoveryDatabaseId);
    if (baselineFile) {
      const baseline = asRecord(
        JSON.parse(await readFile(baselineFile, "utf8")),
      );
      const digests = asRecord(baseline.digests);
      if (
        Object.entries(metadata).some(
          ([key, value]) => baseline[key] !== value,
        ) ||
        Object.keys(digests).length !== RECOVERY_COLLECTIONS.length ||
        RECOVERY_COLLECTIONS.some(
          (name) =>
            typeof digests[name] !== "string" ||
            !/^[0-9a-f]{64}$/.test(digests[name]),
        )
      ) {
        throw new RemoteRecoveryVerificationError(
          "remote_recovery_baseline_invalid",
        );
      }
      const summary = verifyRecoveredRecords(
        digests as Record<string, string>,
        await readRecoveryRecords(recovery),
      );
      process.stdout.write(`${JSON.stringify({ ...summary, snapshotTime })}\n`);
      return;
    }
    const summary = await verifyRemoteRecovery(source, recovery);
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
