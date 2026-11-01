import { readFile } from "node:fs/promises";

import {
  assertFails,
  type RulesTestContext,
  type RulesTestEnvironment,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const rulesProjectId = process.env.GCLOUD_PROJECT ?? "demo-nobody-asked";

describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "deny-by-default Firestore rules",
  () => {
    let environment: RulesTestEnvironment;

    beforeAll(async () => {
      environment = await initializeTestEnvironment({
        projectId: rulesProjectId,
        firestore: {
          rules: await readFile("firestore.rules", "utf8"),
        },
      });
    });

    beforeEach(async () => {
      await environment.clearFirestore();
      await environment.withSecurityRulesDisabled(async (context) => {
        await context
          .firestore()
          .doc("agentProfiles/existing-agent")
          .set({ handle: "existing" });
      });
    });

    afterAll(async () => {
      await environment.cleanup();
    });

    const contexts: readonly [
      string,
      (environment: RulesTestEnvironment) => RulesTestContext,
    ][] = [
      ["unauthenticated client", (value) => value.unauthenticatedContext()],
      [
        "Firebase-authenticated client",
        (value) => value.authenticatedContext("firebase-user-1"),
      ],
    ];

    it.each(contexts)(
      "denies every operation for a %s",
      async (_name, getContext) => {
        const firestore = getContext(environment).firestore();

        await assertFails(firestore.doc("agentProfiles/existing-agent").get());
        await assertFails(firestore.collection("agentProfiles").get());
        await assertFails(
          firestore.doc("agentProfiles/new-agent").set({ handle: "new-agent" }),
        );
        await assertFails(
          firestore
            .doc("agentProfiles/existing-agent")
            .update({ handle: "changed" }),
        );
        await assertFails(
          firestore.doc("agentProfiles/existing-agent").delete(),
        );
      },
    );
  },
);
