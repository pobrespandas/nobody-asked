import { createServer } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const allowedEnvironmentNames = [
  "CI",
  "ComSpec",
  "FORCE_COLOR",
  "HOME",
  "JAVA_HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "TMPDIR",
  "USER",
  "WINDIR",
] as const;

export function buildSanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const name of allowedEnvironmentNames) {
    if (source[name] !== undefined) sanitized[name] = source[name];
  }
  return { ...sanitized, ...overrides };
}

export async function runFirestoreEmulator(
  mode: "exec" | "start",
  source: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const projectId =
    source.FIRESTORE_TEST_PROJECT_ID ?? `demo-nobody-asked-${process.pid}`;
  if (!projectId.startsWith("demo-"))
    throw new Error("FIRESTORE_TEST_PROJECT_ID must start with demo-.");
  const configuredPort = source.FIRESTORE_TEST_PORT
    ? validatePort(source.FIRESTORE_TEST_PORT)
    : null;
  const allocatedPorts = await findAvailablePorts(configuredPort ? 3 : 4);
  const [port, websocketPort, hubPort, loggingPort] = configuredPort
    ? [configuredPort, ...allocatedPorts]
    : allocatedPorts;
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "nobody-asked-firestore-"),
  );
  const configPath = join(temporaryDirectory, "firebase.json");
  const credentialPath = join(temporaryDirectory, "local-credential.json");
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2_048,
  }).privateKey.export({ format: "pem", type: "pkcs8" });
  await writeFile(
    credentialPath,
    JSON.stringify({
      type: "service_account",
      project_id: projectId,
      private_key_id: "local-emulator-only",
      private_key: privateKey,
      client_email: `local@${projectId}.iam.gserviceaccount.com`,
      client_id: "0",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
    }),
    { mode: 0o600 },
  );
  await writeFile(
    configPath,
    JSON.stringify({
      firestore: {
        rules: join(repositoryRoot, "firestore.rules"),
        indexes: join(repositoryRoot, "firestore.indexes.json"),
      },
      emulators: {
        firestore: { host: "127.0.0.1", port, websocketPort },
        hub: { host: "127.0.0.1", port: hubPort },
        logging: { host: "127.0.0.1", port: loggingPort },
        ui: { enabled: false },
        singleProjectMode: true,
      },
    }),
  );

  const environment = buildSanitizedEnvironment(source, {
    GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
  });
  const firebase = join(repositoryRoot, "node_modules/.bin/firebase");
  const args = [
    "emulators:" + mode,
    "--only",
    "firestore",
    "--project",
    projectId,
    "--config",
    configPath,
  ];
  if (mode === "exec") {
    const npmPrefix = shellQuote(repositoryRoot);
    args.push(
      `npm --prefix ${npmPrefix} run firestore:emulator:seed && npm --prefix ${npmPrefix} run test:firestore:emulator:inside && npm --prefix ${npmPrefix} run firestore:emulator:reset`,
    );
  }

  try {
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const child = spawn(firebase, args, {
        cwd: temporaryDirectory,
        env: environment,
        stdio: "inherit",
      });
      child.once("error", reject);
      child.once("exit", resolveExit);
    });
    if (exitCode !== 0)
      throw new Error(
        `Firebase emulator exited with code ${exitCode ?? "unknown"}.`,
      );
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function validatePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("FIRESTORE_TEST_PORT must be a valid TCP port.");
  }
  return port;
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
      if (!address || typeof address === "string")
        throw new Error("Could not allocate a Firebase emulator port.");
      return address.port;
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolveClose) =>
            server.listening
              ? server.close(() => resolveClose())
              : resolveClose(),
          ),
      ),
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runFirestoreEmulator(process.argv[2] === "start" ? "start" : "exec");
}
