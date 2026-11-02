import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertSafeRecoveryTarget,
  buildBackupPlan,
  parseFirestoreBackupConfig,
} from "./firestore-backup.js";

const approved = {
  projectId: "gen-lang-client-0607406471",
  databaseId: "nobody-asked-dev",
  location: "us-central1",
  recurrence: "daily",
  retention: "7d",
  recoveryDatabasePrefix: "nobody-asked-recovery-",
} as const;

describe("Firestore managed backup plan", () => {
  it("keeps every command on the explicit approved source", async () => {
    const file = await readFile("deploy/firestore-backup.json", "utf8");
    const config = parseFirestoreBackupConfig(JSON.parse(file));
    const plan = buildBackupPlan(config);

    expect(plan.createSchedule).toContain(
      "--project=gen-lang-client-0607406471",
    );
    expect(plan.createSchedule).toContain("--database=nobody-asked-dev");
    expect(plan.createSchedule).toContain("--retention=7d");
    expect(JSON.stringify(plan)).not.toContain("delete");
  });

  it("rejects another project, database, location, or excessive retention", () => {
    for (const unsafe of [
      { ...approved, projectId: "another-project" },
      { ...approved, databaseId: "(default)" },
      { ...approved, location: "us-east1" },
      { ...approved, retention: "99d" },
    ]) {
      expect(() => parseFirestoreBackupConfig(unsafe)).toThrow();
    }
  });

  it("requires an isolated recovery database name", () => {
    const config = parseFirestoreBackupConfig(approved);
    expect(() =>
      assertSafeRecoveryTarget(config, "nobody-asked-recovery-20261102"),
    ).not.toThrow();
    expect(() => assertSafeRecoveryTarget(config, "nobody-asked-dev")).toThrow(
      "Recovery database ID is not an isolated target.",
    );
    expect(() => assertSafeRecoveryTarget(config, "production-copy")).toThrow(
      "Recovery database ID is not an isolated target.",
    );
  });
});
