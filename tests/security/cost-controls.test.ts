import { describe, expect, it } from "vitest";

import { validateCostControls } from "../../tools/cost-controls.js";

const complete = {
  formatVersion: 1,
  projectId: "gen-lang-client-0607406471",
  billingAccountId: "01D922-AAADB7-AADCD4",
  currency: "USD",
  budget: {
    amount: 100,
    notificationChannel: "projects/example/notificationChannels/1",
    thresholds: [0.5, 0.75, 0.9, 1],
    automaticShutdown: false,
  },
  usage: {
    firestoreReadsPerHour: 1000,
    firestoreWritesPerHour: 100,
    cloudRunRequestCountPerHour: 1000,
    cloudRunMaxInstances: 3,
    hostingBytesPerHour: 1_000_000,
    logBytesPerHour: 1_000_000,
    egressBytesPerHour: 1_000_000,
    logRetentionDays: 30,
  },
};

describe("cost control decisions", () => {
  it("accepts a complete non-destructive plan", () => {
    expect(validateCostControls(complete)).toEqual({
      ready: true,
      missing: [],
    });
  });

  it("fails closed when financial and usage decisions are absent", () => {
    const result = validateCostControls({
      ...complete,
      budget: { ...complete.budget, amount: null, notificationChannel: null },
      usage: Object.fromEntries(
        Object.keys(complete.usage).map((key) => [
          key,
          key === "logRetentionDays" ? 30 : null,
        ]),
      ),
    });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain("budget.amount");
    expect(result.missing).toContain("budget.notificationChannel");
    expect(result.missing).toContain("usage.egressBytesPerHour");
  });

  it("rejects automatic shutdown", () => {
    expect(
      validateCostControls({
        ...complete,
        budget: { ...complete.budget, automaticShutdown: true },
      }),
    ).toMatchObject({ ready: false, missing: ["budget.automaticShutdown"] });
  });
});
