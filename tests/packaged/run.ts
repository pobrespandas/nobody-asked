import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSanitizedEnvironment } from "@nobody-asked/firestore-support";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const temporaryRoot = await mkdtemp(join(tmpdir(), "nobody-asked-packaged-"));
const cleanRoot = join(temporaryRoot, "source");
const artifactRoot = join(temporaryRoot, "artifact");
let emulator: ChildProcess | undefined;

try {
  await prepareCleanRepository(cleanRoot);
  await run("npm", ["ci"], cleanRoot);
  await run("npm", ["run", "build", "--", "--outDir", artifactRoot], cleanRoot);
  await prepareArtifact(cleanRoot, artifactRoot);
  await run("npm", ["ci", "--omit=dev"], artifactRoot);

  const [firestorePort, websocketPort, hubPort, loggingPort] =
    await findAvailablePorts(4);
  const projectId = `demo-nobody-asked-packaged-${process.pid}`;
  const configPath = join(temporaryRoot, "firebase.json");
  const credentialPath = join(temporaryRoot, "local-credential.json");
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2_048,
  }).privateKey.export({ format: "pem", type: "pkcs8" });
  await writeFile(
    credentialPath,
    JSON.stringify({
      type: "service_account",
      project_id: projectId,
      private_key_id: "packaged-emulator-only",
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
        rules: join(cleanRoot, "firestore.rules"),
        indexes: join(cleanRoot, "firestore.indexes.json"),
      },
      emulators: {
        firestore: { host: "127.0.0.1", port: firestorePort, websocketPort },
        hub: { host: "127.0.0.1", port: hubPort },
        logging: { host: "127.0.0.1", port: loggingPort },
        ui: { enabled: false },
        singleProjectMode: true,
      },
    }),
  );

  const firebase = join(cleanRoot, "node_modules/.bin/firebase");
  const scenario = join(artifactRoot, "apps/packaged-e2e/src/scenario.js");
  const environment = buildSanitizedEnvironment(process.env, {
    FIREBASE_PROJECT_ID: projectId,
    GCLOUD_PROJECT: projectId,
    GOOGLE_CLOUD_PROJECT: projectId,
    GOOGLE_APPLICATION_CREDENTIALS: credentialPath,
    FIRESTORE_DATABASE_ID: "nobody-asked-dev",
  });
  const result = spawn(
    firebase,
    [
      "emulators:exec",
      "--only",
      "firestore",
      "--project",
      projectId,
      "--config",
      configPath,
      `${shellQuote(process.execPath)} ${shellQuote(scenario)}`,
    ],
    { cwd: temporaryRoot, env: environment, stdio: "inherit" },
  );
  emulator = result;
  await waitForSuccess(result, "Firebase emulator");
  emulator = undefined;
} finally {
  if (emulator) await stopChild(emulator);
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function prepareCleanRepository(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const path of [
    "apps",
    "packages",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "firebase.json",
    "firestore.rules",
    "firestore.indexes.json",
  ]) {
    await cp(join(repositoryRoot, path), join(target, path), {
      recursive: true,
    });
  }
}

async function prepareArtifact(
  source: string,
  artifact: string,
): Promise<void> {
  await cp(
    join(source, "package-lock.json"),
    join(artifact, "package-lock.json"),
  );
  await mkdir(join(artifact, "apps/api/openapi"), { recursive: true });
  await cp(
    join(source, "apps/api/openapi/v1.json"),
    join(artifact, "apps/api/openapi/v1.json"),
  );
  await copyManifest(source, artifact, "package.json");
  for (const workspace of ["apps", "packages"]) {
    const rootManifest = JSON.parse(
      await readFile(join(source, "package-lock.json"), "utf8"),
    ) as { packages: Record<string, unknown> };
    const paths = Object.keys(rootManifest.packages).filter((path) =>
      path.startsWith(`${workspace}/`),
    );
    for (const path of paths) {
      if (path.split("/").length !== 2) continue;
      await copyManifest(source, artifact, `${path}/package.json`);
    }
  }
}

async function copyManifest(
  source: string,
  artifact: string,
  path: string,
): Promise<void> {
  const input = JSON.parse(await readFile(join(source, path), "utf8")) as {
    exports?: string;
    [key: string]: unknown;
  };
  if (input.exports) input.exports = input.exports.replace(/\.ts$/, ".js");
  const destination = join(artifact, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(input, null, 2)}\n`);
}

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const child = spawn(command, args, { cwd, stdio: "inherit" });
  await waitForSuccess(child, `${command} ${args.join(" ")}`);
}

async function waitForSuccess(
  child: ChildProcess,
  label: string,
): Promise<void> {
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (code !== 0)
    throw new Error(`${label} exited with code ${code ?? "unknown"}.`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
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
        throw new Error("Could not allocate a packaged test port.");
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
