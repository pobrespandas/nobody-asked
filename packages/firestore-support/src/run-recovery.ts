import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSanitizedEnvironment } from "./run-emulator.js";

export function assertDemoRecoveryProject(projectId: string): void {
  if (!projectId.startsWith("demo-")) {
    throw new Error("FIRESTORE_RECOVERY_PROJECT_ID must start with demo-.");
  }
}

export async function runFirestoreRecovery(
  source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const projectId =
    source.FIRESTORE_RECOVERY_PROJECT_ID ??
    `demo-nobody-asked-recovery-${process.pid}`;
  assertDemoRecoveryProject(projectId);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "nobody-asked-recovery-"),
  );
  const exportDirectory = join(temporaryDirectory, "firestore-export");
  const expectedExportPath = join(temporaryDirectory, "portable-export.json");
  let child: ChildProcess | undefined;

  try {
    const [firestorePort, websocketPort, hubPort, loggingPort] =
      await findAvailablePorts(4);
    const configPath = join(temporaryDirectory, "firebase.json");
    const credentialPath = join(temporaryDirectory, "local-credential.json");
    await writeLocalCredential(credentialPath, projectId);
    await writeFile(
      configPath,
      JSON.stringify({
        firestore: {
          rules: join(repositoryRoot, "firestore.rules"),
          indexes: join(repositoryRoot, "firestore.indexes.json"),
        },
        emulators: {
          firestore: {
            host: "127.0.0.1",
            port: firestorePort,
            websocketPort,
          },
          hub: { host: "127.0.0.1", port: hubPort },
          logging: { host: "127.0.0.1", port: loggingPort },
          ui: { enabled: false },
          singleProjectMode: true,
        },
      }),
    );

    const environment = buildSanitizedEnvironment(source, {
      FIREBASE_PROJECT_ID: projectId,
      GCLOUD_PROJECT: projectId,
      GOOGLE_CLOUD_PROJECT: projectId,
      GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
      FIRESTORE_DATABASE_ID: "nobody-asked-dev",
      FIRESTORE_RECOVERY_USE_DEFAULT_DATABASE: "1",
      FIRESTORE_RECOVERY_EXPECTED_PATH: expectedExportPath,
    });
    const firebase = join(repositoryRoot, "node_modules/.bin/firebase");
    const scenario = join(repositoryRoot, "tests/recovery/scenario.ts");
    const tsx = join(repositoryRoot, "node_modules/.bin/tsx");

    child = startPhase({
      firebase,
      configPath,
      projectId,
      temporaryDirectory,
      environment,
      command: `${shellQuote(tsx)} ${shellQuote(scenario)} seed`,
      exportDirectory,
    });
    await waitForSuccess(child, "Firestore recovery seed and export");
    child = undefined;

    child = startPhase({
      firebase,
      configPath,
      projectId,
      temporaryDirectory,
      environment,
      command: `${shellQuote(tsx)} ${shellQuote(scenario)} empty`,
    });
    await waitForSuccess(child, "Firestore recovery reset verification");
    child = undefined;

    child = startPhase({
      firebase,
      configPath,
      projectId,
      temporaryDirectory,
      environment,
      command: `${shellQuote(tsx)} ${shellQuote(scenario)} recovered`,
      importDirectory: exportDirectory,
    });
    await waitForSuccess(child, "Firestore recovery import verification");
    child = undefined;
  } finally {
    if (child) await stopChild(child);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

interface PhaseInput {
  readonly firebase: string;
  readonly configPath: string;
  readonly projectId: string;
  readonly temporaryDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly command: string;
  readonly exportDirectory?: string;
  readonly importDirectory?: string;
}

function startPhase(input: PhaseInput): ChildProcess {
  const args = [
    "emulators:exec",
    "--only",
    "firestore",
    "--project",
    input.projectId,
    "--config",
    input.configPath,
  ];
  if (input.exportDirectory) {
    args.push("--export-on-exit", input.exportDirectory);
  }
  if (input.importDirectory) args.push("--import", input.importDirectory);
  args.push(input.command);
  return spawn(input.firebase, args, {
    cwd: input.temporaryDirectory,
    env: input.environment,
    stdio: "inherit",
  });
}

async function writeLocalCredential(path: string, projectId: string) {
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2_048,
  }).privateKey.export({ format: "pem", type: "pkcs8" });
  await writeFile(
    path,
    JSON.stringify({
      type: "service_account",
      project_id: projectId,
      private_key_id: "recovery-emulator-only",
      private_key: privateKey,
      client_email: `local@${projectId}.iam.gserviceaccount.com`,
      client_id: "0",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    { mode: 0o600 },
  );
}

async function waitForSuccess(child: ChildProcess, label: string) {
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (code !== 0) {
    throw new Error(`${label} exited with code ${code ?? "unknown"}.`);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const exit = new Promise<void>((resolveExit) =>
    child.once("exit", () => resolveExit()),
  );
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), 5_000),
    ),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exit;
  }
}

async function findAvailablePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolveListen, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolveListen);
          }),
      ),
    );
    return servers.map((server) => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not allocate a Firestore recovery port.");
      }
      return address.port;
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolveClose) =>
            server.close(() => resolveClose()),
          ),
      ),
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runFirestoreRecovery();
}
