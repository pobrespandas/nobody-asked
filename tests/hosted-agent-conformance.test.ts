import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function run(arguments_: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "tools/hosted-agent-conformance.ts", ...arguments_],
    { encoding: "utf8" },
  );
}

describe("hosted Agent conformance destination", () => {
  it("requires an explicit origin", () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use --base-url");
  });

  it.each([
    "http://network.example/",
    "https://network.example/private",
    "https://network.example/?token=private",
    "https://user:private@network.example/",
    "https://network.example/#private",
  ])("rejects unsafe destination %s before discovery", (origin) => {
    const result = run(["--base-url", origin]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Use an HTTPS origin");
    expect(result.stdout).toBe("");
  });
});
