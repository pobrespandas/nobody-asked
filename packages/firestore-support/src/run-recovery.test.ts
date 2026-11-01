import { describe, expect, it } from "vitest";

import { assertDemoRecoveryProject } from "./run-recovery.js";

describe("Firestore recovery guard", () => {
  it("accepts only demo project IDs", () => {
    expect(() => assertDemoRecoveryProject("demo-recovery")).not.toThrow();
    expect(() => assertDemoRecoveryProject("production-project")).toThrow(
      "FIRESTORE_RECOVERY_PROJECT_ID must start with demo-.",
    );
  });
});
