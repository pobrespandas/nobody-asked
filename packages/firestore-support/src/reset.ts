import { pathToFileURL } from "node:url";

import { readLocalFirestoreConfig } from "./admin.js";

export async function resetLocalFirestore(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { projectId, emulatorHost } = readLocalFirestoreConfig(environment);
  const response = await fetch(
    `http://${emulatorHost}/emulator/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(
      `Firestore emulator reset failed with status ${response.status}.`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await resetLocalFirestore();
}
