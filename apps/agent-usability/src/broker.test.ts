import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startBroker } from "./broker.js";
import { ExperimentBudget, NetworkPolicy } from "./policy.js";

describe("experiment MCP boundary", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
  });

  it("blocks a real child fetch before it reaches an unapproved origin", async () => {
    const budget = new ExperimentBudget();
    const broker = await startBroker({
      policy: new NetworkPolicy("https://nobodyasked.pobrespandas.com", budget),
      cliPath: "/unused",
      guardPath: "/unused",
      stateDirectory: "/unused",
      home: "/unused",
      workspace: "/unused",
      redact: async (value) => value,
    });
    close = broker.close;
    const guard = fileURLToPath(new URL("./network-guard.ts", import.meta.url));
    const child = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        guard,
        "--input-type=module",
        "-e",
        'try { await fetch("https://not-approved.invalid/"); process.exitCode=1; } catch(error) { console.log(error.message); }',
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          NOBODY_GUARD_URL: broker.url.replace("/mcp", "/guard"),
          NOBODY_GUARD_TOKEN: broker.token,
        },
        timeout: 10_000,
      },
    );
    expect(child.stdout).toContain("network policy denied");
    expect(budget.snapshot().requests).toBe(0);
  });

  it("requires authentication and rejects private tools and storage arguments", async () => {
    const broker = await startBroker({
      policy: new NetworkPolicy(
        "https://nobodyasked.pobrespandas.com",
        new ExperimentBudget(),
      ),
      cliPath: "/not-invoked",
      guardPath: "/not-invoked",
      stateDirectory: "/private",
      home: "/private",
      workspace: "/private",
      redact: async (value) => value,
    });
    close = broker.close;
    expect(
      (await fetch(broker.url, { method: "POST", body: "{}" })).status,
    ).toBe(403);
    const call = async (method: string, params: unknown = {}) => {
      const response = await fetch(broker.url, {
        method: "POST",
        headers: { authorization: `Bearer ${broker.token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return response.json() as Promise<Record<string, unknown>>;
    };
    const tools = JSON.stringify(await call("tools/list"));
    expect(tools).toContain("fetch_url");
    expect(tools).toContain("run_command");
    expect(tools).not.toContain("/private");
    for (const params of [
      { name: "read_file", arguments: { path: "/private/identity.json" } },
      {
        name: "run_command",
        arguments: { argv: ["cat", "/private/identity.json"] },
      },
      {
        name: "run_command",
        arguments: {
          argv: [
            "npx",
            "@pobrespandas/nobodyasked@0.1.1",
            "context",
            "--state-dir",
            "/private",
          ],
        },
      },
      {
        name: "fetch_url",
        arguments: { url: "file:///private/identity.json" },
      },
      { name: "fetch_url", arguments: { url: "http://169.254.169.254/" } },
    ])
      expect(await call("tools/call", params)).toHaveProperty("error");
    const badOrigin = await fetch(broker.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${broker.token}`,
        origin: "https://evil.example",
      },
      body: "{}",
    });
    expect(badOrigin.status).toBe(403);
  });

  it("counts actual child network attempts and blocks excess publication", () => {
    const budget = new ExperimentBudget();
    const policy = new NetworkPolicy(
      "https://nobodyasked.pobrespandas.com",
      budget,
    );
    const post = {
      url: `${policy.origin}/v1/posts`,
      method: "POST",
      digest: "body-one",
      idempotencyKey: "one",
    };
    policy.allow(post);
    policy.allow(post);
    expect(() => policy.allow({ ...post, digest: "body-two" })).toThrow(
      "post limit",
    );
    expect(() =>
      policy.allow({
        url: `${policy.origin}/v1/operator/invitations`,
        method: "POST",
      }),
    ).toThrow();
    expect(() =>
      policy.allow({
        url: `${policy.origin}/v1/agents/a/recovery-challenges`,
        method: "POST",
        recoveryOperation: "replace_recovery_key",
      }),
    ).toThrow();
    expect(budget.snapshot().requests).toBe(2);
  });
});
