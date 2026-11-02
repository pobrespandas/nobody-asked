import { pathToFileURL } from "node:url";

import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

export const REMOTE_FIRESTORE_SMOKE_QUERY_COUNT = 9;

export type SmokeDirection = "asc" | "desc";
export type SmokeOperator = "==" | "<=" | "in";

export interface FirestoreSmokeQuery {
  where(
    field: string,
    operator: SmokeOperator,
    value: unknown,
  ): FirestoreSmokeQuery;
  orderBy(field: string, direction: SmokeDirection): FirestoreSmokeQuery;
  limit(value: number): FirestoreSmokeQuery;
  get(): Promise<unknown>;
}

export interface FirestoreSmokeDatabase {
  collection(name: string): FirestoreSmokeQuery;
}

export interface RemoteSmokeConfig {
  readonly projectId: string;
  readonly databaseId: string;
}

export interface RemoteSmokeSummary {
  readonly status: "passed";
  readonly queryCount: number;
}

export class RemoteFirestoreSmokeError extends Error {
  constructor(
    readonly code:
      | "remote_smoke_opt_in_required"
      | "remote_smoke_emulator_forbidden"
      | "remote_smoke_project_required"
      | "remote_smoke_project_mismatch"
      | "remote_smoke_project_forbidden"
      | "remote_smoke_database_required"
      | "remote_smoke_database_forbidden"
      | "remote_smoke_query_failed",
    readonly queryName: string | null = null,
  ) {
    super(code);
    this.name = "RemoteFirestoreSmokeError";
  }
}

export function validateRemoteSmokeEnvironment(
  environment: NodeJS.ProcessEnv,
): RemoteSmokeConfig {
  if (environment.ALLOW_REMOTE_FIRESTORE_SMOKE !== "1") {
    throw new RemoteFirestoreSmokeError("remote_smoke_opt_in_required");
  }
  if (Object.hasOwn(environment, "FIRESTORE_EMULATOR_HOST")) {
    throw new RemoteFirestoreSmokeError("remote_smoke_emulator_forbidden");
  }

  const target = environment.REMOTE_FIRESTORE_PROJECT_ID;
  const adcProject = environment.GOOGLE_CLOUD_PROJECT;
  if (!target || !adcProject) {
    throw new RemoteFirestoreSmokeError("remote_smoke_project_required");
  }
  const configuredIds = [
    adcProject,
    environment.GCLOUD_PROJECT,
    environment.FIREBASE_PROJECT_ID,
  ].filter((value): value is string => value !== undefined);
  if (configuredIds.some((value) => value !== target)) {
    throw new RemoteFirestoreSmokeError("remote_smoke_project_mismatch");
  }
  if (
    target.startsWith("demo-") ||
    target === "querelo-prod" ||
    target.startsWith("querelo-prod-")
  ) {
    throw new RemoteFirestoreSmokeError("remote_smoke_project_forbidden");
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(target)) {
    throw new RemoteFirestoreSmokeError("remote_smoke_project_forbidden");
  }

  const databaseId = environment.REMOTE_FIRESTORE_DATABASE_ID;
  if (!databaseId) {
    throw new RemoteFirestoreSmokeError("remote_smoke_database_required");
  }
  if (
    databaseId === "(default)" ||
    databaseId === "querelo-prod" ||
    databaseId.startsWith("querelo-prod-") ||
    !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(databaseId)
  ) {
    throw new RemoteFirestoreSmokeError("remote_smoke_database_forbidden");
  }

  return Object.freeze({
    projectId: target,
    databaseId,
  });
}

export async function runRemoteFirestoreIndexSmoke(
  firestore: FirestoreSmokeDatabase,
  now: Date = new Date(),
): Promise<RemoteSmokeSummary> {
  const missingId = "remote-index-smoke-missing-id";
  const queries: readonly [string, FirestoreSmokeQuery][] = [
    [
      "public_timeline",
      firestore
        .collection("publicItems")
        .where("visibility", "==", "visible")
        .orderBy("publishedAt", "desc")
        .orderBy("id", "desc"),
    ],
    [
      "agent_public_activity",
      firestore
        .collection("publicItems")
        .where("authorId", "==", missingId)
        .where("visibility", "==", "visible")
        .orderBy("publishedAt", "desc")
        .orderBy("id", "desc"),
    ],
    [
      "personal_feed",
      firestore
        .collection("publicItems")
        .where("authorId", "in", [missingId])
        .where("visibility", "==", "visible")
        .orderBy("publishedAt", "desc")
        .orderBy("id", "desc"),
    ],
    [
      "conversation",
      firestore
        .collection("publicItems")
        .where("conversationRootId", "==", missingId)
        .where("visibility", "==", "visible")
        .orderBy("publishedAt", "asc")
        .orderBy("id", "asc"),
    ],
    [
      "following",
      firestore
        .collection("follows")
        .where("followerId", "==", missingId)
        .orderBy("followedAt", "desc")
        .orderBy("followedId", "asc"),
    ],
    [
      "followers",
      firestore
        .collection("follows")
        .where("followedId", "==", missingId)
        .orderBy("followedAt", "desc")
        .orderBy("followerId", "asc"),
    ],
    [
      "open_reports",
      firestore
        .collection("reports")
        .where("resolvedAt", "==", null)
        .orderBy("reportedAt", "asc")
        .orderBy("id", "asc"),
    ],
    [
      "audit_by_subject",
      firestore
        .collection("auditRecords")
        .where("subjectType", "==", "agent")
        .where("subjectId", "==", missingId)
        .orderBy("createdAt", "desc")
        .orderBy("id", "desc"),
    ],
    [
      "expired_audit_records",
      firestore
        .collection("auditRecords")
        .where("expireAt", "<=", now)
        .orderBy("expireAt", "asc")
        .orderBy("id", "asc"),
    ],
  ];

  for (const [queryName, query] of queries) {
    try {
      await query.limit(1).get();
    } catch {
      throw new RemoteFirestoreSmokeError(
        "remote_smoke_query_failed",
        queryName,
      );
    }
  }
  return Object.freeze({ status: "passed", queryCount: queries.length });
}

export async function runRemoteFirestoreIndexSmokeCli(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = validateRemoteSmokeEnvironment(environment);
  const app = initializeApp({
    credential: applicationDefault(),
    projectId: config.projectId,
  });
  try {
    const summary = await runRemoteFirestoreIndexSmoke(
      getFirestore(app, config.databaseId) as unknown as FirestoreSmokeDatabase,
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
    await runRemoteFirestoreIndexSmokeCli();
  } catch (error) {
    const stable =
      error instanceof RemoteFirestoreSmokeError
        ? { status: "failed", code: error.code, query: error.queryName }
        : { status: "failed", code: "remote_smoke_unexpected_error" };
    process.stderr.write(`${JSON.stringify(stable)}\n`);
    process.exitCode = 1;
  }
}
