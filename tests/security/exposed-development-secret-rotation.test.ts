import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const path = "docs/operations/exposed-development-secret-rotation.md";

describe("exposed development secret rotation runbook", () => {
  it("covers every exposed variable and provider branch", async () => {
    const runbook = await readFile(path, "utf8");

    for (const value of [
      "CURSOR_API_KEY",
      "GEMINI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "## Cursor",
      "## Gemini",
      "## Telegram",
    ]) {
      expect(runbook).toContain(value);
    }
  });

  it("requires revocation, replacement, verification, and a safe stop", async () => {
    const runbook = await readFile(path, "utf8");

    for (const heading of ["## Cursor", "## Gemini", "## Telegram"]) {
      const start = runbook.indexOf(heading);
      const next = runbook.indexOf("\n## ", start + heading.length);
      const section = runbook.slice(start, next < 0 ? runbook.length : next);
      expect(section).toMatch(/revoke|revoked|revocation/i);
      expect(section).toMatch(/replacement/i);
      expect(section).toMatch(/verify|verification/i);
      expect(section).toContain("Safe stop:");
    }
  });

  it("keeps secret values out of manual command arguments and URLs", async () => {
    const runbook = await readFile(path, "utf8");

    expect(runbook).toContain("Do not use `--api-key`");
    expect(runbook).toContain("Do not run a manual `curl` verification");
    expect(runbook).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    expect(runbook).not.toMatch(/[0-9]{8,12}:[A-Za-z0-9_-]{30,}/);
  });
});
