import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface CostControlDecision {
  readonly ready: boolean;
  readonly missing: readonly string[];
}

export function validateCostControls(input: unknown): CostControlDecision {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ready: false, missing: ["config"] };
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
  if (!positiveNumber(budget?.amount)) missing.push("budget.amount");
  if (!nonEmptyString(budget?.notificationChannel))
    missing.push("budget.notificationChannel");
  if (budget?.automaticShutdown !== false)
    missing.push("budget.automaticShutdown");
  if (
    JSON.stringify(budget?.thresholds) !== JSON.stringify([0.5, 0.75, 0.9, 1])
  )
    missing.push("budget.thresholds");

  for (const name of [
    "firestoreReadsPerHour",
    "firestoreWritesPerHour",
    "cloudRunRequestCountPerHour",
    "cloudRunMaxInstances",
    "hostingBytesPerHour",
    "logBytesPerHour",
    "egressBytesPerHour",
  ]) {
    if (!positiveNumber(usage?.[name])) missing.push(`usage.${name}`);
  }
  if (usage?.logRetentionDays !== 30) missing.push("usage.logRetentionDays");

  return Object.freeze({
    ready: missing.length === 0,
    missing: Object.freeze(missing),
  });
}

function positiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
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
      `${JSON.stringify({ ready: false, missing: ["config"] })}\n`,
    );
    process.exitCode = 1;
  }
}
