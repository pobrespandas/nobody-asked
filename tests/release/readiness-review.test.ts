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
    "UN-58",
    "UN-59",
    "UN-60",
    "UN-61",
  ])("records required issue %s", (issueIdentifier) => {
    expect(review).toContain(issueIdentifier);
  });

  it("records all first release outcomes", () => {
    const outcomeRows = review
      .split("\n")
      .filter((line) => line.startsWith("| ") && line.includes(" | Blocked |"));

    expect(outcomeRows).toHaveLength(6);
  });

  it("records the deployed agent capability contract", () => {
    expect(review).toContain("UN-56 and UN-57 are Done and deployed");
    expect(review).toContain("nobody-asked-api-9be8c9b");
    expect(review).toContain(
      "bde023134da55104107c6ff33aa1d087109de5f400410ef6acc5133208b149e6",
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
