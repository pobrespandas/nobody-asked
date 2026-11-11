import { expect, it } from "vitest";
import { operationsObservation } from "./operations-view.js";
it("distinguishes missing observations from no backups", () => {
  expect(operationsObservation(null)).toContain(
    "does not mean that no backup exists",
  );
});
it("shows stale capture, backup time and partial service failures without raw JSON", () => {
  const html = operationsObservation(
    {
      verifiedAt: "2026-11-07T00:00:00Z",
      cloud: {
        database: {
          status: "available",
          deleteProtectionState: "DELETE_PROTECTION_ENABLED",
        },
        queue: { status: "unavailable" },
        runtime: { status: "available", capacity: { maximumInstances: 2 } },
      },
      backup: { snapshotTime: "2026-11-07T02:33:11Z", name: "<script>" },
    },
    new Date("2026-11-11T00:00:00Z"),
  );
  expect(html).toContain("more than 24 hours old");
  expect(html).toContain("Maximum Instances");
  expect(html).toContain("23:33 ART");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<pre>");
});
