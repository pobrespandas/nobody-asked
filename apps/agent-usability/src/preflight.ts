import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";

const execute = promisify(execFile);

export function permissionConfig(workspace: string): string {
  if (!workspace.startsWith("/"))
    throw new Error("Workspace must be absolute.");
  return `permissions.experiment.filesystem={":root"="deny",":minimal"="read",${JSON.stringify(workspace)}="write"}`;
}

export interface PreflightResult {
  platform: string;
  positiveRead: boolean;
  deniedReads: { target: string; denied: boolean }[];
  directNetworkDenied: boolean;
}

/** Probe the same OS policy used by the SDK. Never read an actual secret. */
export async function isolationPreflight(
  codexPath: string,
  repositories: string[],
): Promise<PreflightResult> {
  if (process.platform !== "darwin")
    throw new Error("The reviewed isolation probe requires macOS.");
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "nobody-isolation-")),
  );
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const sdk = join(root, "sdk");
  const identity = join(root, "identity");
  try {
    for (const directory of [workspace, home, sdk, identity])
      await mkdir(directory, { mode: 0o700 });
    const marker = randomUUID();
    const publicFile = join(workspace, "public.txt");
    await writeFile(publicFile, "public-probe", { mode: 0o600 });
    const sdkCanary = join(sdk, "auth.json");
    const identityCanary = join(identity, "identity.json");
    for (const file of [sdkCanary, identityCanary])
      await writeFile(file, marker, { mode: 0o600 });
    const read = async (
      file: string,
    ): Promise<{ ok: boolean; denied: boolean }> => {
      try {
        const result = await execute(
          codexPath,
          [
            "sandbox",
            "-P",
            "experiment",
            "-c",
            permissionConfig(workspace),
            "-c",
            "permissions.experiment.network.enabled=false",
            "-C",
            workspace,
            "/bin/cat",
            file,
          ],
          {
            env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: sdk },
            timeout: 15_000,
            maxBuffer: 65_536,
          },
        );
        return { ok: result.stdout === "public-probe", denied: false };
      } catch (error) {
        const result = error as {
          code?: number;
          stderr?: string;
          stdout?: string;
        };
        return {
          ok: false,
          denied:
            result.code === 1 &&
            !!result.stderr?.includes("Operation not permitted") &&
            !result.stdout,
        };
      }
    };
    const positiveRead = (await read(publicFile)).ok;
    const targets = [
      { target: "SDK authentication canary", path: sdkCanary },
      { target: "Agent identity canary", path: identityCanary },
      ...repositories.map((repository, index) => ({
        target: `source repository ${index + 1}`,
        path: resolve(repository, "README.md"),
      })),
    ];
    const deniedReads = [];
    for (const target of targets)
      deniedReads.push({
        target: target.target,
        denied: (await read(target.path)).denied,
      });
    let requests = 0;
    const listener = createServer((_request, response) => {
      requests++;
      response.end("reachable");
    });
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    let directNetworkDenied = false;
    try {
      const address = listener.address();
      if (!address || typeof address === "string")
        throw new Error("No probe address.");
      const url = `http://127.0.0.1:${address.port}/`;
      const positive = await fetch(url);
      if ((await positive.text()) !== "reachable" || requests !== 1)
        throw new Error("Network probe control failed.");
      requests = 0;
      try {
        await execute(
          codexPath,
          [
            "sandbox",
            "-P",
            "experiment",
            "-c",
            permissionConfig(workspace),
            "-c",
            "permissions.experiment.network.enabled=false",
            "-C",
            workspace,
            "/usr/bin/curl",
            "--silent",
            "--show-error",
            "--max-time",
            "3",
            url,
          ],
          {
            env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: sdk },
            timeout: 10_000,
          },
        );
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        directNetworkDenied =
          typeof code === "number" && code !== 0 && requests === 0;
      }
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    const result = {
      platform: process.platform,
      positiveRead,
      deniedReads,
      directNetworkDenied,
    };
    if (
      !positiveRead ||
      !directNetworkDenied ||
      deniedReads.some((probe) => !probe.denied)
    )
      throw new Error(
        "OS isolation preflight failed. Hosted writes are forbidden.",
      );
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
