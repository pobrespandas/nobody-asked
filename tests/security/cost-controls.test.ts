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
    firestoreReadsPerHour: 5_000,
    firestoreWritesPerHour: 1_000,
    cloudRunRequestCountPerHour: 10_000,
    cloudRunMaxInstances: 2,
    hostingBytesPerHour: 500_000_000,
    logBytesPerHour: 100_000_000,
    egressBytesPerHour: 500_000_000,
    logRetentionDays: 30,
  },
  alerts: {
    notificationChannel:
      "projects/gen-lang-client-0607406471/notificationChannels/1",
    windowSeconds: 3_600,
    perSeriesAligner: "ALIGN_SUM",
    crossSeriesReducer: "REDUCE_SUM",
    targets: {
      firestoreDatabaseId: "nobody-asked-dev",
      firestoreLocation: "us-central1",
      cloudRunService: "nobody-asked-api",
      cloudRunLocation: "us-central1",
      hostingSite: "nobodyasked-pobrespandas-prod",
      logProject: "gen-lang-client-0607406471",
      egressScope: "cloud-run-service",
    },
    policies: Object.fromEntries(
      Object.entries({
        firestoreReads: "firestore.googleapis.com/document/read_ops_count",
        firestoreWrites: "firestore.googleapis.com/document/write_ops_count",
        cloudRunRequests: "run.googleapis.com/request_count",
        hostingBytes: "firebasehosting.googleapis.com/network/sent_bytes_count",
        logBytes: "logging.googleapis.com/billing/bytes_ingested",
        egressBytes: "run.googleapis.com/container/network/sent_bytes_count",
      }).map(([name, metricType], index) => [
        name,
        {
          resourceName: `projects/gen-lang-client-0607406471/alertPolicies/${index + 1}`,
          metricType,
        },
      ]),
    ),
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

  it("rejects a changed threshold or an unverified metric", () => {
    const result = validateCostControls({
      ...complete,
      usage: { ...complete.usage, cloudRunMaxInstances: 20 },
      alerts: {
        ...complete.alerts,
        policies: {
          ...complete.alerts.policies,
          egressBytes: {
            resourceName: "projects/gen-lang-client-0607406471/alertPolicies/6",
            metricType: "networking.googleapis.com/egress_bytes_count",
          },
        },
      },
    });
    expect(result.missing).toEqual(
      expect.arrayContaining([
        "usage.cloudRunMaxInstances",
        "alerts.policies.egressBytes.metricType",
      ]),
    );
  });
});
