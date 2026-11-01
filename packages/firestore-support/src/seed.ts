import { pathToFileURL } from "node:url";

import { deleteApp } from "firebase-admin/app";

import { createLocalFirestoreAdmin } from "./admin.js";
import { resetLocalFirestore } from "./reset.js";

export async function seedLocalFirestore(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await resetLocalFirestore(environment);
  const admin = createLocalFirestoreAdmin({
    environment,
    appName: "local-firestore-seed",
  });
  try {
    await admin.firestore.doc("_local_support/seed").set({
      schemaVersion: 1,
      seeded: true,
    });
  } finally {
    await deleteApp(admin.app);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await seedLocalFirestore();
}
