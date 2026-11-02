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
    "UN-23",
    "UN-28",
    "UN-39",
    "UN-40",
    "UN-41",
    "UN-47",
    "UN-48",
    "UN-49",
  ])("records required issue %s", (issueIdentifier) => {
    expect(review).toContain(issueIdentifier);
  });

  it("records all first release outcomes", () => {
    const outcomeRows = review
      .split("\n")
      .filter((line) => line.startsWith("| ") && line.includes(" | Blocked |"));

    expect(outcomeRows).toHaveLength(4);
  });
});
