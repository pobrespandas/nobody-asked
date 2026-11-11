import { requireAdmin } from "./contracts.js";
export interface AdminConfig {
  origin: string;
  googleClientId: string;
  googleClientSecret: string;
  projectId: string;
  databaseId: string;
  queue: string | null;
  taskUrl: string | null;
  taskServiceAccount: string | null;
  ledgerBucket: string | null;
}
export function readAdminConfig(
  env: NodeJS.ProcessEnv = process.env,
): AdminConfig | null {
  if (env.ADMIN_ENABLED !== "true") return null;
  const required = (name: string) => {
    const value = env[name];
    requireAdmin(value, 500, `missing_${name.toLowerCase()}`);
    return value;
  };
  const origin = required("ADMIN_ORIGIN");
  requireAdmin(
    new URL(origin).origin === origin && origin.startsWith("https://"),
    500,
    "invalid_admin_origin",
  );
  const queue = env.ADMIN_TASK_QUEUE ?? null;
  const taskUrl = env.ADMIN_TASK_URL ?? null;
  const taskServiceAccount = env.ADMIN_TASK_SERVICE_ACCOUNT ?? null;
  const ledgerBucket = env.ADMIN_LEDGER_BUCKET ?? null;
  requireAdmin(
    [queue, taskUrl, taskServiceAccount, ledgerBucket].every(Boolean) ||
      [queue, taskUrl, taskServiceAccount, ledgerBucket].every(
        (value) => value === null,
      ),
    500,
    "incomplete_job_configuration",
  );
  if (queue) {
    requireAdmin(
      /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/queues\/[a-zA-Z0-9-]+$/.test(
        queue,
      ),
      500,
    );
    requireAdmin(
      new URL(taskUrl!).protocol === "https:" &&
        new URL(taskUrl!).pathname === "/internal/admin/jobs",
      500,
    );
  }
  return {
    origin,
    googleClientId: required("ADMIN_GOOGLE_CLIENT_ID"),
    googleClientSecret: required("ADMIN_GOOGLE_CLIENT_SECRET"),
    projectId: required("NOBODY_ASKED_GCP_PROJECT_ID"),
    databaseId: required("FIRESTORE_DATABASE_ID"),
    queue,
    taskUrl,
    taskServiceAccount,
    ledgerBucket,
  };
}
