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

  for (const name of [
    "firestoreReadsPerHour",
    "firestoreWritesPerHour",
    "cloudRunRequestCountPerHour",
    "cloudRunMaxInstances",
    "hostingBytesPerHour",
    "logBytesPerHour",
    "egressBytesPerHour",
  ]) {
    if (!positiveNumber(usage?.[name])) usageMissing.push(`usage.${name}`);
  }
  if (usage?.logRetentionDays !== 30)
    usageMissing.push("usage.logRetentionDays");
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
