import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { execFileSync } from "node:child_process";
import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { requireAdmin } from "../apps/api/src/admin/contracts.js";
interface Backup {
  name: string;
  database: string;
  snapshotTime: string;
  expireTime: string;
  state: string;
}
function firestoreFields(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const encode = (item: unknown): unknown =>
    item === null
      ? { nullValue: null }
      : typeof item === "string"
        ? { stringValue: item }
        : typeof item === "boolean"
          ? { booleanValue: item }
          : typeof item === "number"
            ? { doubleValue: item }
            : Array.isArray(item)
              ? { arrayValue: { values: item.map(encode) } }
              : {
                  mapValue: {
                    fields: firestoreFields(item as Record<string, unknown>),
                  },
                };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, encode(item)]),
  );
}
async function main() {
  const project = process.env.NOBODY_ASKED_GCP_PROJECT_ID,
    database = process.env.FIRESTORE_DATABASE_ID;
  requireAdmin(
    project &&
      project !== "querelo-prod" &&
      database &&
      database !== "(default)",
    400,
    "explicit_configuration_required",
  );
  requireAdmin(
    process.argv.slice(2).every((arg) => arg === "--gcloud-auth"),
    400,
    "unknown_option",
  );
  const auth = process.argv.includes("--gcloud-auth")
    ? new OAuth2Client()
    : await new GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      }).getClient();
  if (process.argv.includes("--gcloud-auth"))
    auth.setCredentials({
      access_token: execFileSync("gcloud", ["auth", "print-access-token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    });
  const backupSource = `https://firestore.googleapis.com/v1/projects/${project}/locations/us-central1/backups`;
  const backups: Backup[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.request<{
      backups?: Backup[];
      nextPageToken?: string;
    }>({
      url: backupSource,
      params: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
    });
    backups.push(...(page.data.backups ?? []));
    pageToken = page.data.nextPageToken;
  } while (pageToken);
  const latest = backups
    .filter(
      (backup) =>
        backup.database === `projects/${project}/databases/${database}` &&
        backup.state === "READY",
    )
    .sort((left, right) =>
      right.snapshotTime.localeCompare(left.snapshotTime),
    )[0];
  const serviceSource = `https://run.googleapis.com/v2/projects/${project}/locations/us-central1/services/nobody-asked-api`;
  const cloudSources = {
    runtime: serviceSource,
    database: `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}`,
    queue: `https://cloudtasks.googleapis.com/v2/projects/${project}/locations/us-central1/queues/nobody-asked-admin`,
  };
  const observations = await Promise.all(
    Object.entries(cloudSources).map(async ([section, url]) => {
      try {
        const response = await auth.request<Record<string, unknown>>({ url });
        const data = response.data;
        const fields =
          section === "runtime"
            ? [
                "latestReadyRevision",
                "trafficStatuses",
                "reconciling",
                "terminalCondition",
              ]
            : section === "database"
              ? [
                  "locationId",
                  "type",
                  "concurrencyMode",
                  "deleteProtectionState",
                  "pointInTimeRecoveryEnablement",
                  "versionRetentionPeriod",
                  "earliestVersionTime",
                ]
              : ["state", "rateLimits", "retryConfig"];
        const selected = Object.fromEntries(
          fields
            .filter((key) => data[key] !== undefined)
            .map((key) => [key, data[key]]),
        );
        if (section === "runtime") {
          const template = data.template as
            | {
                maxInstanceRequestConcurrency?: number;
                timeout?: string;
                scaling?: {
                  minInstanceCount?: number;
                  maxInstanceCount?: number;
                };
                containers?: {
                  resources?: { limits?: Record<string, string> };
                }[];
              }
            | undefined;
          selected.capacity = {
            concurrency: template?.maxInstanceRequestConcurrency ?? null,
            timeout: template?.timeout ?? null,
            minimumInstances: template?.scaling?.minInstanceCount ?? 0,
            maximumInstances: template?.scaling?.maxInstanceCount ?? null,
            limits: template?.containers?.[0]?.resources?.limits ?? null,
          };
        }
        return [
          section,
          { status: "available", source: url, ...selected },
        ] as const;
      } catch {
        return [section, { status: "unavailable", source: url }] as const;
      }
    }),
  );
  const cloud = Object.fromEntries(observations);
  const observation = {
    verifiedAt: new Date().toISOString(),
    source: { backups: backupSource, runtime: serviceSource },
    revision: cloud.runtime?.latestReadyRevision ?? null,
    cloud,
    backup: latest
      ? {
          name: latest.name,
          snapshotTime: latest.snapshotTime,
          expireTime: latest.expireTime,
          state: latest.state,
        }
      : null,
  };
  if (process.argv.includes("--gcloud-auth")) {
    const destination = `https://firestore.googleapis.com/v1/projects/${project}/databases/${database}/documents/adminObservations/runtime`;
    await auth.request({
      url: destination,
      method: "PATCH",
      data: { fields: firestoreFields(observation) },
    });
    const readback = await auth.request<{
      fields?: { verifiedAt?: { stringValue?: string } };
    }>({ url: destination });
    requireAdmin(
      readback.data.fields?.verifiedAt?.stringValue === observation.verifiedAt,
      500,
      "observation_verification_failed",
    );
  } else {
    const app = initializeApp({
      projectId: project,
      credential: applicationDefault(),
    });
    try {
      await getFirestore(app, database)
        .collection("adminObservations")
        .doc("runtime")
        .set({
          ...observation,
          verifiedAt: Timestamp.fromDate(new Date(observation.verifiedAt)),
        });
    } finally {
      await deleteApp(app);
    }
  }
  console.log(
    "Administrative runtime and backup observations were recorded and checked.",
  );
}
void main().catch((error: unknown) => {
  const failure = error as {
    code?: string | number;
    response?: { status?: number };
  };
  console.error(
    "Observation failure code:",
    failure.response?.status ?? failure.code ?? "unknown",
  );
  console.error(
    "Observation capture failed. Prior observations remain unchanged.",
  );
  process.exitCode = 1;
});
