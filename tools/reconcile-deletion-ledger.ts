import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { cloudJobs } from "../apps/api/src/admin/cloud.js";
import {
  reconcileDeletionLedger,
  activateRecoveryGate,
} from "../apps/api/src/admin/recovery.js";
import { requireAdmin } from "../apps/api/src/admin/contracts.js";

async function main() {
  const projectId = process.env.NOBODY_ASKED_GCP_PROJECT_ID;
  const source = process.env.FIRESTORE_DATABASE_ID;
  const restored = process.env.RESTORE_DATABASE_ID;
  const bucket = process.env.ADMIN_LEDGER_BUCKET;
  requireAdmin(
    process.argv.includes("--apply") &&
      projectId &&
      projectId !== "querelo-prod" &&
      source &&
      restored &&
      restored !== source &&
      restored !== "(default)" &&
      bucket &&
      process.env.SOURCE_WRITES_PAUSED === "true",
    400,
    "isolated_restore_configuration_required",
  );
  const objects = cloudJobs({
    projectId,
    databaseId: restored,
    ledgerBucket: bucket,
    queue: null,
    taskUrl: null,
    taskServiceAccount: null,
    origin: "https://unused.invalid",
    googleClientId: "unused",
    googleClientSecret: "unused",
  }).objects!;
  const app = initializeApp({ projectId, credential: applicationDefault() });
  try {
    const firestore = getFirestore(app, restored);
    const result = await reconcileDeletionLedger(firestore, objects);
    if (process.argv.includes("--activate"))
      await activateRecoveryGate(firestore, result.recoveryId);
    console.log(
      JSON.stringify({
        ...result,
        activated: process.argv.includes("--activate"),
      }),
    );
  } finally {
    await deleteApp(app);
  }
}
void main().catch(() => {
  console.error(
    "Deletion reconciliation failed. The restored database is not ready for traffic.",
  );
  process.exitCode = 1;
});
