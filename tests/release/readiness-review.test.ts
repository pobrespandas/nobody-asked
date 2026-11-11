import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const review = readFileSync(
  new URL(
    "../../docs/product/first-release-readiness-review.md",
    import.meta.url,
  ),
  "utf8",
);

describe("first release readiness review", () => {
  it("records the blocked release decision", () => {
    expect(review).toContain("Release decision: **Blocked**");
    expect(review).toContain("No first release outcome is `Not applicable`");
  });

  it.each([
    "UN-19",
    "UN-23",
    "UN-28",
    "UN-41",
    "UN-47",
    "UN-48",
    "UN-49",
    "UN-62",
  ])("records required issue %s", (issueIdentifier) => {
    expect(review).toContain(issueIdentifier);
  });

  it("preserves the historical blockers and records the current operational gates", () => {
    const [current, historical] = review.split("## Historical review");
    const outcomeRows = historical!
      .split("\n")
      .filter((line) => line.startsWith("| ") && line.includes(" | Blocked |"));

    expect(outcomeRows).toHaveLength(7);
    expect(current).toContain("| Main-domain login and moderation | Pass |");
    expect(current).toContain("| Distinct Operator reassignment | Pass |");
    for (const gate of [
      "Challenge delivery from the serving revision",
      "Portable moderation state",
      "Managed restore",
      "Routing recovery",
      "First release",
    ]) {
      expect(current).toContain(`| ${gate} | Blocked |`);
    }
  });

  it("records the deployed agent capability contract", () => {
    expect(review).toContain("UN-56 and UN-57 are Done and deployed");
    expect(review).toContain("nobody-asked-api-825cba5");
    expect(review).toContain(
      "712d82c56c0cc63a61c6bd8b7c5ad173c20b56974d1bc0bde8228c2adaaad605",
    );
    expect(review).toContain(
      "5487cfcf47a4d28cd11cd85174df0ad5d12a56dee96914fef8942bef9695261d",
    );
  });

  it("records the active managed backup schedule", () => {
    expect(review).toContain("1a5096f2-0f37-4946-a566-2256cebe78aa");
    expect(review).toContain("No managed backup exists yet");
  });

  it("does not approve an empty hosted network", () => {
    expect(review).toContain("no record in any application collection");
    expect(review).toContain("No hosted Operator can authenticate");
  });
});
