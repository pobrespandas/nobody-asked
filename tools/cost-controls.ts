import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface CostControlDecision {
  readonly ready: boolean;
  readonly budgetReady: boolean;
  readonly usageReady: boolean;
  readonly missing: readonly string[];
}

export function validateCostControls(input: unknown): CostControlDecision {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ready: false,
      budgetReady: false,
      usageReady: false,
      missing: ["config"],
    };
  }
  const value = input as Record<string, unknown>;
  const budget = value.budget as Record<string, unknown> | undefined;
  const usage = value.usage as Record<string, unknown> | undefined;
  const alerts = value.alerts as Record<string, unknown> | undefined;
  const targets = alerts?.targets as Record<string, unknown> | undefined;
  const policies = alerts?.policies as Record<string, unknown> | undefined;
  const missing: string[] = [];

  if (value.formatVersion !== 1) missing.push("formatVersion");
  if (value.projectId !== "gen-lang-client-0607406471")
    missing.push("projectId");
  if (value.billingAccountId !== "01D922-AAADB7-AADCD4")
    missing.push("billingAccountId");
  if (value.currency !== "USD") missing.push("currency");
  if (
    !matches(
      budget?.resourceName,
      /^billingAccounts\/01D922-AAADB7-AADCD4\/budgets\/[a-z0-9-]+$/,
    )
  )
    missing.push("budget.resourceName");
  if (!positiveNumber(budget?.amount)) missing.push("budget.amount");
  if (
    !matches(
      budget?.notificationChannel,
      /^projects\/gen-lang-client-0607406471\/notificationChannels\/[0-9]+$/,
    )
  )
    missing.push("budget.notificationChannel");
  if (!matches(budget?.notificationRecipient, /^[^\s@]+@[^\s@]+\.[^\s@]+$/))
    missing.push("budget.notificationRecipient");
  if (budget?.automaticShutdown !== false)
    missing.push("budget.automaticShutdown");
  if (JSON.stringify(budget?.thresholds) !== JSON.stringify([0.5, 0.8, 1]))
    missing.push("budget.thresholds");
  const budgetReady = missing.length === 0;
  const usageMissing: string[] = [];

  const expectedUsage = {
    firestoreReadsPerHour: 5_000,
    firestoreWritesPerHour: 1_000,
    cloudRunRequestCountPerHour: 10_000,
    cloudRunMaxInstances: 2,
    hostingBytesPerHour: 500_000_000,
    logBytesPerHour: 100_000_000,
    egressBytesPerHour: 500_000_000,
  } as const;
  for (const [name, expected] of Object.entries(expectedUsage)) {
    if (usage?.[name] !== expected) usageMissing.push(`usage.${name}`);
  }
  if (usage?.logRetentionDays !== 30)
    usageMissing.push("usage.logRetentionDays");
  if (alerts?.notificationChannel !== budget?.notificationChannel)
    usageMissing.push("alerts.notificationChannel");
  if (alerts?.windowSeconds !== 3_600)
    usageMissing.push("alerts.windowSeconds");
  if (alerts?.perSeriesAligner !== "ALIGN_SUM")
    usageMissing.push("alerts.perSeriesAligner");
  if (alerts?.crossSeriesReducer !== "REDUCE_SUM")
    usageMissing.push("alerts.crossSeriesReducer");

  const expectedTargets = {
    firestoreDatabaseId: "nobody-asked-dev",
    firestoreLocation: "us-central1",
    cloudRunService: "nobody-asked-api",
    cloudRunLocation: "us-central1",
    hostingSite: "nobodyasked-pobrespandas-prod",
    logProject: "gen-lang-client-0607406471",
    egressScope: "cloud-run-service",
  } as const;
  for (const [name, expected] of Object.entries(expectedTargets)) {
    if (targets?.[name] !== expected)
      usageMissing.push(`alerts.targets.${name}`);
  }

  const expectedMetrics = {
    firestoreReads: "firestore.googleapis.com/document/read_ops_count",
    firestoreWrites: "firestore.googleapis.com/document/write_ops_count",
    cloudRunRequests: "run.googleapis.com/request_count",
    hostingBytes: "firebasehosting.googleapis.com/network/sent_bytes_count",
    logBytes: "logging.googleapis.com/billing/bytes_ingested",
    egressBytes: "run.googleapis.com/container/network/sent_bytes_count",
  } as const;
  for (const [name, metricType] of Object.entries(expectedMetrics)) {
    const policy = policies?.[name] as Record<string, unknown> | undefined;
    if (
      !matches(
        policy?.resourceName,
        /^projects\/gen-lang-client-0607406471\/alertPolicies\/[0-9]+$/,
      )
    )
      usageMissing.push(`alerts.policies.${name}.resourceName`);
    if (policy?.metricType !== metricType)
      usageMissing.push(`alerts.policies.${name}.metricType`);
  }
  missing.push(...usageMissing);

  return Object.freeze({
    ready: missing.length === 0,
    budgetReady,
    usageReady: usageMissing.length === 0,
    missing: Object.freeze(missing),
  });
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function matches(value: unknown, pattern: RegExp): boolean {
  return typeof value === "string" && pattern.test(value);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const path = process.argv[2];
    if (!path) throw new Error("cost_control_file_required");
    const decision = validateCostControls(
      JSON.parse(await readFile(path, "utf8")),
    );
    process.stdout.write(`${JSON.stringify(decision)}\n`);
    if (!decision.ready) process.exitCode = 2;
  } catch {
    process.stderr.write(
      `${JSON.stringify({ ready: false, budgetReady: false, usageReady: false, missing: ["config"] })}\n`,
    );
    process.exitCode = 1;
  }
}
