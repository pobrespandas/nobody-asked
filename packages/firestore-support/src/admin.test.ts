import { deleteApp } from "firebase-admin/app";
import {
  assertFails,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { afterAll, describe, expect, it } from "vitest";

import {
  LOCAL_FIREBASE_PROJECT_ID,
  LOCAL_FIRESTORE_DATABASE_ID,
  createLocalFirestoreAdmin,
  readLocalFirestoreConfig,
} from "./admin.js";
import { resetLocalFirestore } from "./reset.js";
import { buildSanitizedEnvironment } from "./run-emulator.js";

describe("local Firestore configuration", () => {
  const safeEnvironment = {
    FIREBASE_PROJECT_ID: "demo-safe",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    FIRESTORE_DATABASE_ID: LOCAL_FIRESTORE_DATABASE_ID,
  };

  it.each([
    [{ FIREBASE_PROJECT_ID: "demo-safe" }, "FIRESTORE_EMULATOR_HOST"],
    [
      {
        FIREBASE_PROJECT_ID: "demo-safe",
        FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443",
        FIRESTORE_DATABASE_ID: LOCAL_FIRESTORE_DATABASE_ID,
      },
      "localhost",
    ],
    [
      {
        FIREBASE_PROJECT_ID: "production-project",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        FIRESTORE_DATABASE_ID: LOCAL_FIRESTORE_DATABASE_ID,
      },
      "demo-",
    ],
    [
      {
        FIREBASE_PROJECT_ID: "demo-one",
        GCLOUD_PROJECT: "demo-two",
        FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
        FIRESTORE_DATABASE_ID: LOCAL_FIRESTORE_DATABASE_ID,
      },
      "must match",
    ],
    [safeEnvironment, ""],
    [
      { ...safeEnvironment, FIRESTORE_DATABASE_ID: undefined },
      "FIRESTORE_DATABASE_ID",
    ],
    [
      { ...safeEnvironment, FIRESTORE_DATABASE_ID: "(default)" },
      "safe non-default",
    ],
    [
      { ...safeEnvironment, FIRESTORE_DATABASE_ID: "querelo-prod" },
      "safe non-default",
    ],
  ])("fails closed for unsafe environment %#", (environment, message) => {
    if (message) {
      expect(() => readLocalFirestoreConfig(environment)).toThrow(message);
    } else {
      expect(readLocalFirestoreConfig(environment)).toEqual({
        projectId: "demo-safe",
        emulatorHost: "127.0.0.1:8080",
        databaseId: LOCAL_FIRESTORE_DATABASE_ID,
      });
    }
  });

  it("does not pass unrelated secrets to Firebase CLI", () => {
    const environment = buildSanitizedEnvironment({
      PATH: process.env.PATH,
      CURSOR_API_KEY: "cursor-secret",
      GEMINI_API_KEY: "gemini-secret",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
    });
    expect(environment).toHaveProperty("PATH");
    expect(environment).not.toHaveProperty("CURSOR_API_KEY");
    expect(environment).not.toHaveProperty("GEMINI_API_KEY");
    expect(environment).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
  });
});

describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "Firestore emulator integration",
  () => {
    const environment = process.env;
    const admins: ReturnType<typeof createLocalFirestoreAdmin>[] = [];

    afterAll(async () => {
      await Promise.all(admins.map(({ app }) => deleteApp(app)));
    });

    it("uses Admin SDK locally and resets data deterministically", async () => {
      const admin = createLocalFirestoreAdmin({ environment });
      admins.push(admin);
      await admin.firestore.doc("checks/admin").set({ local: true });
      await expect(
        admin.firestore.doc("checks/admin").get(),
      ).resolves.toMatchObject({
        exists: true,
      });

      await resetLocalFirestore(environment);
      const snapshot = await admin.firestore.doc("checks/admin").get();
      expect(snapshot.exists).toBe(false);
    });

    it("denies every client read and write by default", async () => {
      const testEnvironment = await initializeTestEnvironment({
        projectId: environment.GCLOUD_PROJECT ?? LOCAL_FIREBASE_PROJECT_ID,
      });
      try {
        const client = testEnvironment.unauthenticatedContext().firestore();
        await assertFails(client.doc("checks/client").set({ denied: true }));
        await assertFails(client.doc("checks/client").get());
      } finally {
        await testEnvironment.cleanup();
      }
    });
  },
);
