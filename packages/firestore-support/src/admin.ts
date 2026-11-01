import {
  applicationDefault,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

export const LOCAL_FIREBASE_PROJECT_ID = "demo-nobody-asked";
export const LOCAL_FIRESTORE_EMULATOR_HOST = "127.0.0.1:8180";

export interface LocalFirestoreConfig {
  readonly projectId: string;
  readonly emulatorHost: string;
}

export interface LocalFirestoreAdmin {
  readonly app: App;
  readonly firestore: Firestore;
  readonly config: LocalFirestoreConfig;
}

export function readLocalFirestoreConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LocalFirestoreConfig {
  const emulatorHost = environment.FIRESTORE_EMULATOR_HOST;
  if (!emulatorHost) {
    throw new Error("FIRESTORE_EMULATOR_HOST is required for local Firestore.");
  }
  const match = emulatorHost.match(/^(127\.0\.0\.1|localhost):([1-9]\d{0,4})$/);
  const port = match?.[2] ? Number(match[2]) : 0;
  if (!match || port > 65_535) {
    throw new Error(
      "FIRESTORE_EMULATOR_HOST must use localhost or 127.0.0.1 with a valid port.",
    );
  }

  const configuredProjectIds = [
    environment.FIREBASE_PROJECT_ID,
    environment.GCLOUD_PROJECT,
    environment.GOOGLE_CLOUD_PROJECT,
  ].filter((value): value is string => Boolean(value));
  const projectId = configuredProjectIds[0];
  if (!projectId) {
    throw new Error(
      "A demo Firebase project ID is required for local Firestore.",
    );
  }
  if (configuredProjectIds.some((value) => value !== projectId)) {
    throw new Error(
      "Local Firebase project ID environment variables must match.",
    );
  }
  if (!projectId.startsWith("demo-")) {
    throw new Error(
      "Local Firestore requires a project ID that starts with demo-.",
    );
  }

  return Object.freeze({ projectId, emulatorHost });
}

export function createLocalFirestoreAdmin(input?: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly appName?: string;
}): LocalFirestoreAdmin {
  const config = readLocalFirestoreConfig(input?.environment);
  const app = initializeApp(
    { projectId: config.projectId, credential: applicationDefault() },
    input?.appName ?? `local-firestore-${crypto.randomUUID()}`,
  );
  return Object.freeze({ app, firestore: getFirestore(app), config });
}
