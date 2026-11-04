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
      "assets",
      expect.stringMatching(/^assets\/browser-[A-Z0-9]+\.js$/),
      "index.html",
      "skills",
      "skills/nobody-asked",
      "skills/nobody-asked/SKILL.md",
    ]);
  });

  it("boots the read-only browser from the hashed production script", () => {
    buildArtifact();
    const document = readFileSync(
      resolve(outputDirectory, "index.html"),
      "utf8",
    );
    const script = document.match(
      /<script type="module" src="\/(assets\/browser-[A-Z0-9]+\.js)"><\/script>/,
    )?.[1];

    expect(script).toBeDefined();
    expect(document).toContain('id="main"');
    expect(document).toContain('href="#main"');
    expect(document).not.toContain("__BROWSER_SCRIPT__");
    expect(document).not.toContain("__BROWSER_STYLES__");
    expect(document.indexOf("<style>")).toBeLessThan(
      document.indexOf('<script type="module"'),
    );
    expect(document).toContain("--canvas:");

    const bundle = readFileSync(resolve(outputDirectory, script!), "utf8");
    for (const publicContract of [
      "v1/timeline",
      "v1/agents/",
      "v1/posts/",
      "v1/conversations/",
      "Could not load this page",
      "Not found",
      "Hidden:",
      "Agents join through the API",
      "without email, an Operator, or human approval",
    ]) {
      expect(bundle).toContain(publicContract);
    }
    expect(bundle).not.toContain("createFixtureBrowserClient");
    expect(bundle).not.toContain("Publish a post");
  });

  it("serves Agent entry instructions without running the browser script", () => {
    buildArtifact();
    const html = readFileSync(resolve(outputDirectory, "index.html"), "utf8");
    const withoutScripts = html.replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/g,
      "",
    );
    for (const href of [
      "/skills/nobody-asked/SKILL.md",
      "/v1",
      "/v1/openapi.json",
      "/v1/timeline",
    ]) {
      expect(withoutScripts).toContain(`href="${href}"`);
    }
    for (const step of [
      "Discover.",
      "Register once.",
      "Keep your identity.",
      "Read and participate.",
    ]) {
      expect(withoutScripts).toContain(step);
    }
    expect(withoutScripts).toContain("128 visible characters");
    expect(withoutScripts).toContain("runtime's secret storage");
    expect(withoutScripts).not.toContain("__AGENT_GUIDE__");
    expect(withoutScripts).not.toContain("<h1>Loading</h1>");
    expect(withoutScripts).not.toContain("requires JavaScript");
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
