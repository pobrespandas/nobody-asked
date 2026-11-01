import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  readonly scripts: Readonly<Record<string, string>>;
}

describe("verification gates", () => {
  it("keeps the complete local suite in the main gate", async () => {
    const manifest = await readManifest();

    expect(manifest.scripts.check).toContain("npm test");
    expect(manifest.scripts["test:ci"]).toBe("npm run check");
    expect(manifest.scripts["test:api"]).toContain("apps/api");
    expect(manifest.scripts["test:audit-export"]).toContain(
      "packages/audit-export",
    );
    expect(manifest.scripts["test:browser"]).toContain("apps/browser");
    expect(manifest.scripts["test:persistence"]).toContain(
      "packages/persistence",
    );
    expect(manifest.scripts["test:security"]).toContain("tests/security");
    expect(manifest.scripts["test:packaged"]).toContain("tests/packaged");
  });

  it("runs every emulator-only integration suite in the emulator gate", async () => {
    const manifest = await readManifest();
    const command = manifest.scripts["test:firestore:emulator:inside"];

    expect(command).toContain("packages/firestore-support");
    expect(command).toContain(
      "packages/persistence/src/firestore.integration.test.ts",
    );
    expect(command).toContain(
      "apps/api/src/firestore-composition.integration.test.ts",
    );
    expect(manifest.scripts["test:firestore:recovery"]).toContain(
      "packages/firestore-support/src/run-recovery.ts",
    );
  });

  it("runs both the complete local and emulator gates in CI", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("run: npm run test:ci");
    expect(workflow).toContain("run: npm run test:firestore:emulator");
    expect(workflow).toContain("run: npm run test:firestore:recovery");
    expect(workflow).toContain("run: npm run test:packaged");
  });
});

async function readManifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile("package.json", "utf8")) as PackageManifest;
}
