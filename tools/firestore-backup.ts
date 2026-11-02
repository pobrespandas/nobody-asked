import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const APPROVED_BACKUP_PROJECT = "gen-lang-client-0607406471";
export const APPROVED_BACKUP_DATABASE = "nobody-asked-dev";
export const APPROVED_BACKUP_LOCATION = "us-central1";

export interface FirestoreBackupConfig {
  readonly projectId: string;
  readonly databaseId: string;
  readonly location: string;
  readonly recurrence: "daily";
  readonly retention: string;
  readonly recoveryDatabasePrefix: string;
}

export function parseFirestoreBackupConfig(
  input: unknown,
): FirestoreBackupConfig {
  if (!isRecord(input))
    throw new Error("Backup configuration must be an object.");
  const config = {
    projectId: readString(input, "projectId"),
    databaseId: readString(input, "databaseId"),
    location: readString(input, "location"),
    recurrence: readString(input, "recurrence"),
    retention: readString(input, "retention"),
    recoveryDatabasePrefix: readString(input, "recoveryDatabasePrefix"),
  };
  if (config.projectId !== APPROVED_BACKUP_PROJECT) {
    throw new Error(`Backup project must be ${APPROVED_BACKUP_PROJECT}.`);
  }
  if (config.databaseId !== APPROVED_BACKUP_DATABASE) {
    throw new Error(`Backup database must be ${APPROVED_BACKUP_DATABASE}.`);
  }
  if (config.location !== APPROVED_BACKUP_LOCATION) {
    throw new Error(`Backup location must be ${APPROVED_BACKUP_LOCATION}.`);
  }
  if (config.recurrence !== "daily") {
    throw new Error("Backup recurrence must be daily.");
  }
  if (!/^([1-9]|[1-9][0-9])d$/.test(config.retention)) {
    throw new Error("Backup retention must be from 1d through 99d.");
  }
  if (Number.parseInt(config.retention, 10) > 98) {
    throw new Error("Backup retention must not exceed 98d.");
  }
  if (config.recoveryDatabasePrefix !== "nobody-asked-recovery-") {
    throw new Error("Recovery databases must use the approved prefix.");
  }
  return config as FirestoreBackupConfig;
}

export function buildBackupPlan(config: FirestoreBackupConfig) {
  return {
    inspectSchedule: [
      "gcloud",
      "firestore",
      "backups",
      "schedules",
      "list",
      `--project=${config.projectId}`,
      `--database=${config.databaseId}`,
      "--format=json",
    ],
    createSchedule: [
      "gcloud",
      "firestore",
      "backups",
      "schedules",
      "create",
      `--project=${config.projectId}`,
      `--database=${config.databaseId}`,
      `--recurrence=${config.recurrence}`,
      `--retention=${config.retention}`,
    ],
    listBackups: [
      "gcloud",
      "firestore",
      "backups",
      "list",
      `--project=${config.projectId}`,
      `--location=${config.location}`,
      "--format=json",
    ],
  } as const;
}

export function buildRecoveryPlan(
  config: FirestoreBackupConfig,
  backupName: string,
  recoveryDatabaseId: string,
) {
  assertSafeRecoveryTarget(config, recoveryDatabaseId);
  const prefix = `projects/${config.projectId}/locations/${config.location}/backups/`;
  if (!backupName.startsWith(prefix) || backupName.length <= prefix.length) {
    throw new Error(
      "Backup name must identify the approved project and location.",
    );
  }
  return {
    restore: [
      "gcloud",
      "firestore",
      "databases",
      "restore",
      `--project=${config.projectId}`,
      `--source-backup=${backupName}`,
      `--destination-database=${recoveryDatabaseId}`,
    ],
    verifyTarget: [
      "gcloud",
      "firestore",
      "databases",
      "describe",
      `--project=${config.projectId}`,
      `--database=${recoveryDatabaseId}`,
      "--format=json",
    ],
  } as const;
}

export function assertSafeRecoveryTarget(
  config: FirestoreBackupConfig,
  recoveryDatabaseId: string,
): void {
  if (
    recoveryDatabaseId === config.databaseId ||
    !recoveryDatabaseId.startsWith(config.recoveryDatabasePrefix) ||
    recoveryDatabaseId.length <= config.recoveryDatabasePrefix.length
  ) {
    throw new Error("Recovery database ID is not an isolated target.");
  }
}

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const raw = await readFile(
    resolve(root, "deploy/firestore-backup.json"),
    "utf8",
  );
  const config = parseFirestoreBackupConfig(JSON.parse(raw));
  process.stdout.write(`${JSON.stringify(buildBackupPlan(config), null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }
  return value[key];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
