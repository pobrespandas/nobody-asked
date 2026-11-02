import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface HostedSecretBinding {
  readonly environmentVariable: string;
  readonly secretVersion: string;
}

export interface HostedRuntimeSecretConfig {
  readonly formatVersion: 1;
  readonly projectId: string;
  readonly runtimeServiceAccount: string;
  readonly bindings: readonly HostedSecretBinding[];
}

export class RuntimeSecretConfigError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RuntimeSecretConfigError";
  }
}

const projectPattern = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const environmentVariablePattern = /^[A-Z][A-Z0-9_]{1,63}$/;
const reservedEnvironmentVariables = new Set([
  "FIREBASE_PROJECT_ID",
  "FIRESTORE_DATABASE_ID",
  "GCLOUD_PROJECT",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
]);

export function parseHostedRuntimeSecretConfig(
  input: unknown,
): HostedRuntimeSecretConfig {
  const root = readExactObject(input, [
    "formatVersion",
    "projectId",
    "runtimeServiceAccount",
    "bindings",
  ]);
  if (root.formatVersion !== 1) fail("runtime_secret_format_invalid");

  const projectId = readString(
    root.projectId,
    "runtime_secret_project_invalid",
  );
  if (
    !projectPattern.test(projectId) ||
    projectId.startsWith("demo-") ||
    projectId === "querelo-prod" ||
    projectId.startsWith("querelo-prod-")
  ) {
    fail("runtime_secret_project_invalid");
  }

  const runtimeServiceAccount = readString(
    root.runtimeServiceAccount,
    "runtime_secret_identity_invalid",
  );
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]@/.test(runtimeServiceAccount) ||
    !runtimeServiceAccount.endsWith(`@${projectId}.iam.gserviceaccount.com`)
  ) {
    fail("runtime_secret_identity_invalid");
  }

  if (!Array.isArray(root.bindings) || root.bindings.length === 0) {
    fail("runtime_secret_bindings_required");
  }
  const environmentVariables = new Set<string>();
  const bindings = root.bindings.map((entry) => {
    const binding = readExactObject(entry, [
      "environmentVariable",
      "secretVersion",
    ]);
    const environmentVariable = readString(
      binding.environmentVariable,
      "runtime_secret_environment_invalid",
    );
    if (
      !environmentVariablePattern.test(environmentVariable) ||
      reservedEnvironmentVariables.has(environmentVariable) ||
      environmentVariables.has(environmentVariable)
    ) {
      fail("runtime_secret_environment_invalid");
    }
    environmentVariables.add(environmentVariable);

    const secretVersion = readString(
      binding.secretVersion,
      "runtime_secret_version_invalid",
    );
    const match = secretVersion.match(
      /^projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/secrets\/([A-Za-z0-9_-]{1,255})\/versions\/([1-9]\d*)$/,
    );
    if (!match || match[1] !== projectId) {
      fail("runtime_secret_version_invalid");
    }
    return Object.freeze({ environmentVariable, secretVersion });
  });

  return Object.freeze({
    formatVersion: 1,
    projectId,
    runtimeServiceAccount,
    bindings: Object.freeze(bindings),
  });
}

export async function validateHostedRuntimeSecretConfigFile(
  path: string,
): Promise<{ readonly status: "valid"; readonly bindingCount: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("runtime_secret_file_invalid");
  }
  const config = parseHostedRuntimeSecretConfig(parsed);
  return Object.freeze({
    status: "valid",
    bindingCount: config.bindings.length,
  });
}

function readExactObject(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("runtime_secret_shape_invalid");
  }
  const record = input as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail("runtime_secret_shape_invalid");
  }
  return record;
}

function readString(input: unknown, code: string): string {
  if (typeof input !== "string" || input.length === 0) fail(code);
  return input;
}

function fail(code: string): never {
  throw new RuntimeSecretConfigError(code);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const path = process.argv[2];
    if (!path) fail("runtime_secret_file_required");
    const result = await validateHostedRuntimeSecretConfigFile(path);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof RuntimeSecretConfigError
        ? error.code
        : "runtime_secret_unexpected_error";
    process.stderr.write(`${JSON.stringify({ status: "invalid", code })}\n`);
    process.exitCode = 1;
  }
}
