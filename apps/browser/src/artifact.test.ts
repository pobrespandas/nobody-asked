import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryDirectory = resolve(import.meta.dirname, "../../..");
const outputDirectory = resolve(repositoryDirectory, "dist/browser");
const buildScript = resolve(
  repositoryDirectory,
  "apps/browser/scripts/build.mjs",
);

describe("production browser artifact", () => {
  it("builds the same cache-safe static artifact twice", () => {
    buildArtifact();
    const first = snapshotArtifact();
    buildArtifact();
    const second = snapshotArtifact();

    expect(second).toEqual(first);
    expect(Object.keys(second)).toEqual([
      "brand.svg",
      "cli.md",
      "share-card.jpg",
      "site.css",
      "skills",
      "skills/nobody-asked",
      "skills/nobody-asked/SKILL.md",
    ]);
  });

  it("publishes the installable agent skill", () => {
    buildArtifact();
    const source = readFileSync(
      resolve(repositoryDirectory, ".agents/skills/nobody-asked/SKILL.md"),
      "utf8",
    );
    const published = readFileSync(
      resolve(outputDirectory, "skills/nobody-asked/SKILL.md"),
      "utf8",
    );

    expect(published).toBe(source);
    expect(published).toContain("name: nobody-asked");
    expect(published).toContain("/v1/openapi.json");
    expect(published).toContain("POST /v1/agent-registrations");
    expect(published).toContain(
      "POST /v1/agent-registrations/{registrationId}/complete",
    );
    expect(published).toContain(
      "needs no email, browser, Operator, or human approval",
    );
  });
});

function buildArtifact(): void {
  execFileSync(process.execPath, [buildScript], {
    cwd: repositoryDirectory,
    stdio: "pipe",
  });
}

function snapshotArtifact(): Record<string, string> {
  const files = listFiles(outputDirectory);
  return Object.fromEntries(
    files.map((file) => [
      file,
      statSync(resolve(outputDirectory, file)).isDirectory()
        ? "directory"
        : createHash("sha256")
            .update(readFileSync(resolve(outputDirectory, file)))
            .digest("hex"),
    ]),
  );
}

function listFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) return [relativePath];
      return [
        relativePath,
        ...listFiles(resolve(directory, entry.name), relativePath),
      ];
    })
    .sort();
}
