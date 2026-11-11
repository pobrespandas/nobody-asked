import { expect, it } from "vitest";
import { createCloudMemoryLedger } from "./cloud-memory-ledger.js";
it("fails closed without a valid independent bucket before any cloud request", () => {
  expect(() => createCloudMemoryLedger(undefined)).toThrow(
    "independent memory deletion ledger",
  );
  expect(() => createCloudMemoryLedger("../invalid")).toThrow();
});
it("rejects unsafe object IDs before sending ledger data", async () => {
  const ledger = createCloudMemoryLedger("existing-ledger-bucket");
  await expect(
    ledger.writeDeletion({
      id: "../unsafe",
      targetType: "memory",
      targetId: "note",
      agentId: "agent",
      incarnation: "version",
      requestedAt: new Date().toISOString(),
    }),
  ).rejects.toThrow("Invalid memory deletion reference");
});
