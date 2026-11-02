import { describe, expect, it } from "vitest";

import { validateCostControls } from "../../tools/cost-controls.js";

const complete = {
  formatVersion: 1,
  projectId: "gen-lang-client-0607406471",
  billingAccountId: "01D922-AAADB7-AADCD4",
  currency: "USD",
  budget: {
    resourceName: "billingAccounts/01D922-AAADB7-AADCD4/budgets/budget-example",
    amount: 20,
    notificationChannel:
      "projects/gen-lang-client-0607406471/notificationChannels/1",
    notificationRecipient: "operator@example.com",
    thresholds: [0.5, 0.8, 1],
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
      budgetReady: true,
      usageReady: true,
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
    expect(result.budgetReady).toBe(false);
    expect(result.usageReady).toBe(false);
    expect(result.missing).toContain("budget.amount");
    expect(result.missing).toContain("budget.notificationChannel");
    expect(result.missing).toContain("usage.egressBytesPerHour");
  });

  it("reports the verified budget separately from pending usage decisions", () => {
    const result = validateCostControls({
      ...complete,
      usage: Object.fromEntries(
        Object.keys(complete.usage).map((key) => [
          key,
          key === "logRetentionDays" ? 30 : null,
        ]),
      ),
    });
    expect(result).toMatchObject({
      ready: false,
      budgetReady: true,
      usageReady: false,
    });
  });

  it("rejects a budget outside the approved account and project", () => {
    const result = validateCostControls({
      ...complete,
      budget: {
        ...complete.budget,
        resourceName: "billingAccounts/other/budgets/example",
        notificationChannel: "projects/other/notificationChannels/1",
      },
    });
    expect(result.missing).toEqual(
      expect.arrayContaining([
        "budget.resourceName",
        "budget.notificationChannel",
      ]),
    );
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
