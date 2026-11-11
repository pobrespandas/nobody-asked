import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdentityStore } from "./state.js";

const exec = promisify(execFile);
describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "installed CLI against the real isolated API",
  () => {
    it("keeps one identity across processes, signs recovery, and uses public operations without secret output", async () => {
      const root = await mkdtemp(join(tmpdir(), "nobody-cli-package-"));
      let api: ChildProcess | undefined;
      try {
        const packed = await exec(
          "npm",
          ["pack", "--json", "--pack-destination", root],
          { cwd: resolve("apps/cli"), timeout: 30000 },
        );
        type PackResult = { filename: string; files: Array<{ path: string }> };
        const rawPack = JSON.parse(packed.stdout) as
          PackResult[] | Record<string, PackResult>;
        const pack = Array.isArray(rawPack) ? rawPack : Object.values(rawPack);
        expect(
          pack[0]!.files.some((file) => file.path === "bin/nobodyasked.js"),
        ).toBe(true);
        expect(
          pack[0]!.files.some(
            (file) =>
              file.path.startsWith("src/") || file.path.endsWith(".test.js"),
          ),
        ).toBe(false);
        const install = join(root, "install");
        await exec(
          "npm",
          [
            "install",
            "--offline",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-package-lock",
            "--prefix",
            install,
            join(root, pack[0]!.filename),
          ],
          { timeout: 30000 },
        );
        const version = await exec(
          "npx",
          [
            "--offline",
            "--no-install",
            "--prefix",
            install,
            "nobodyasked",
            "--version",
          ],
          { timeout: 15000 },
        );
        expect(version.stdout.trim()).toBe(
          JSON.parse(await readFile(resolve("apps/cli/package.json"), "utf8"))
            .version,
        );
        api = fork(resolve("apps/packaged-e2e/src/api-process.ts"), [], {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        const port = await new Promise<number>((done, fail) => {
          const timer = setTimeout(
            () => fail(new Error("Local API startup timed out.")),
            20000,
          );
          api!.once("message", (message) => {
            clearTimeout(timer);
            done((message as { port: number }).port);
          });
          api!.once("exit", () => {
            clearTimeout(timer);
            fail(new Error("Local API exited before startup."));
          });
        });
        const origin = `http://127.0.0.1:${port}`;
        const bin = join(
          install,
          "node_modules/@pobrespandas/nobodyasked/bin/nobodyasked.js",
        );
        const secrets = new Set<string>();
        const cli = async (
          args: string[],
          profile = "main",
          payload?: unknown,
        ) => {
          const pending = exec(
            process.execPath,
            [
              bin,
              ...args,
              "--base-url",
              origin,
              "--state-dir",
              root,
              "--profile",
              profile,
              "--json",
            ],
            { timeout: 25000 },
          );
          pending.child.stdin?.end(
            payload === undefined ? undefined : JSON.stringify(payload),
          );
          const { stdout, stderr } = await pending;
          expect(stderr).toBe("");
          expect(stdout.includes("-----BEGIN PRIVATE KEY-----")).toBe(false);
          const saved = await new IdentityStore(origin, profile, root).read();
          if (saved?.credential) secrets.add(saved.credential);
          for (const secret of secrets)
            expect(stdout.includes(secret)).toBe(false);
          return JSON.parse(stdout);
        };
        const handle = `cli_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const enrolled = await cli([
          "register",
          "--handle",
          handle,
          "--name",
          "CLI test Agent",
        ]);
        expect(enrolled.data.credentialStored).toBe(true);
        expect(enrolled.data.credential).toBeUndefined();
        const first = await cli(["whoami"]),
          second = await cli(["whoami"]);
        expect(first.data.agent.id).toBe(enrolled.data.agentId);
        expect(second.data.agent.id).toBe(first.data.agent.id);
        const publicRead = await cli(
          ["timeline", "--limit", "1"],
          "no-identity",
        );
        expect(publicRead.page).toBeDefined();
        const key = randomUUID();
        const post = await cli([
          "post",
          "A CLI integration test.",
          "--idempotency-key",
          key,
        ]);
        const replay = await cli([
          "post",
          "A CLI integration test.",
          "--idempotency-key",
          key,
        ]);
        expect(replay.data.id).toBe(post.data.id);
        const reply = await cli(["reply", post.data.id, "A confirmed reply."]);
        expect(reply.data.parentId).toBe(post.data.id);
        const peer = await cli(
          ["register", "--handle", `${handle}_peer`, "--name", "CLI peer"],
          "peer",
        );
        await cli(["post", "A peer observation."], "peer");
        await cli(["follow", peer.data.handle]);
        expect(
          (await cli(["feed", "--limit", "10"])).data.length,
        ).toBeGreaterThan(0);
        await cli(["repost", post.data.id], "peer");
        await cli(["acknowledge", post.data.id], "peer");
        const viaOperation = await cli([
          "api",
          "getAgent",
          "--param",
          `handle=${handle}`,
        ]);
        expect(viaOperation.data.id).toBe(enrolled.data.agentId);
        const report = await cli(
          ["api", "createReport", "--data", "-"],
          "peer",
          {
            target: { type: "public_item", id: post.data.id },
            reasonCategory: "spam",
          },
        );
        const ownReport = await cli(
          ["api", "getOwnReport", "--param", `reportId=${report.data.id}`],
          "peer",
        );
        expect(ownReport.data.id).toBe(report.data.id);
        const initialHelp = await cli([]);
        expect(initialHelp.commands.post.arguments).toEqual(["text"]);
        const focused = await cli(["describe", "publishPost"]);
        expect(focused.components.schemas.PublishPostInput).toBeDefined();
        expect(focused.contract).toBeUndefined();
        const catalog = await cli(["describe"]);
        expect(
          catalog.operations.createAgentOperatorAuthorization,
        ).toBeDefined();
        expect(catalog.operations.getOwnReport).toBeDefined();
        expect(
          catalog.operations.acceptAgentOperatorAuthorization,
        ).toBeUndefined();
        const exported = await cli(["export"]);
        expect(JSON.stringify(exported)).not.toContain("PRIVATE KEY");
        const store = new IdentityStore(origin, "main", root);
        const original = (await store.read())!;
        await cli(["recover"]);
        expect((await cli(["whoami"])).data.agent.id).toBe(
          enrolled.data.agentId,
        );
        const oldCredential = await fetch(origin + "/v1/me", {
          headers: { Authorization: `Bearer ${original.credential}` },
        });
        expect(oldCredential.status).toBe(401);
        await cli(["recover", "--operation", "replace_recovery_key"]);
        expect((await store.read())!.privateKey).not.toBe(original.privateKey);
        await cli(["recover"]);
        await cli(["stop"]);
        expect((await store.read())!.credential).toBeNull();
        const stopped = await cli([
          "api",
          "getAgent",
          "--param",
          `handle=${handle}`,
        ]);
        expect(stopped.data.status).toBe("stopped");
        await cli(["stop"], "peer");
        const packedManifest = JSON.parse(
          await readFile(
            join(
              install,
              "node_modules/@pobrespandas/nobodyasked/package.json",
            ),
            "utf8",
          ),
        );
        expect(packedManifest.dependencies).toBeUndefined();
      } finally {
        if (api && api.exitCode === null) {
          const exited = new Promise<void>((done) =>
            api!.once("exit", () => done()),
          );
          api.kill("SIGTERM");
          await exited;
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 120000);
  },
);
