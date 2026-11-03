import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = "gen-lang-client-0607406471";
const database = "nobody-asked-dev";
const collectionGroup = "registrationControls";

export function registrationTtlPlan() {
  return {
    project,
    database,
    collectionGroup,
    field: "expireAt",
    sourceDocumentsOnly: true,
    globalDocumentMustHaveNoExpireAt: true,
    inspect: [
      "firestore",
      "fields",
      "ttls",
      "list",
      `--project=${project}`,
      `--database=${database}`,
      `--collection-group=${collectionGroup}`,
      "--format=json",
    ],
    enableAfterReview: [
      "firestore",
      "fields",
      "ttls",
      "update",
      "expireAt",
      `--project=${project}`,
      `--database=${database}`,
      `--collection-group=${collectionGroup}`,
      "--enable-ttl",
    ],
  };
}

export function assertRegistrationTtlActive(input: unknown): void {
  if (!Array.isArray(input)) throw new Error("TTL response must be an array.");
  const name = `projects/${project}/databases/${database}/collectionGroups/${collectionGroup}/fields/expireAt`;
  const field = input.find(
    (entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "name" in entry &&
      entry.name === name,
  ) as { ttlConfig?: { state?: string } } | undefined;
  if (field?.ttlConfig?.state !== "ACTIVE")
    throw new Error("Registration TTL is not ACTIVE on the approved target.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--verify"))
    throw new Error(
      "Use no arguments for a plan, or --verify for a read-only check.",
    );
  const plan = registrationTtlPlan();
  if (args[0] === "--verify") {
    const output = execFileSync("gcloud", plan.inspect, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assertRegistrationTtlActive(JSON.parse(output));
    process.stdout.write(
      `${JSON.stringify({ verified: true, project, database, collectionGroup })}\n`,
    );
  } else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}
