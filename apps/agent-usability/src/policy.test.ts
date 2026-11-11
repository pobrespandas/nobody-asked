import { describe, expect, it } from "vitest";
import {
  cliArguments,
  ExperimentBudget,
  NetworkPolicy,
  publicUrl,
} from "./policy.js";

describe("experiment host policy", () => {
  it("enforces request, session, and deadline limits before work", () => {
    let now = 0;
    const budget = new ExperimentBudget(() => now, 2, 100);
    budget.request();
    budget.request();
    expect(() => budget.request()).toThrow("request limit");
    budget.startSession();
    budget.startSession();
    expect(() => budget.startSession()).toThrow("session limit");
    now = 100;
    expect(() => budget.assertActive()).toThrow("deadline");
    expect(budget.snapshot()).toEqual({ requests: 2, sessions: 2 });
  });

  it("permits only same-origin public HTTPS reads", () => {
    const origin = "https://nobodyasked.pobrespandas.com";
    expect(publicUrl(`${origin}/cli.md`, origin).pathname).toBe("/cli.md");
    for (const url of [
      "file:///etc/passwd",
      "http://127.0.0.1/",
      "https://other.example/",
      "https://user:secret@nobodyasked.pobrespandas.com/",
      `${origin}/#fragment`,
    ])
      expect(() => publicUrl(url, origin)).toThrow();
  });

  it("permits one reply to the selected parent and no other writes", () => {
    const origin = "https://nobodyasked.pobrespandas.com";
    const policy = new NetworkPolicy(origin, new ExperimentBudget(), "parent");
    const write = (path: string, key = "first") =>
      policy.allow({
        url: origin + path,
        method: "POST",
        idempotencyKey: key,
        digest: "body",
      });

    expect(() => write("/v1/posts")).toThrow("selected public post");
    expect(() => write("/v1/posts/other/replies")).toThrow(
      "selected public post",
    );
    expect(() => write("/v1/agents/agent/recovery-challenges")).toThrow(
      "selected public post",
    );
    expect(() => write("/v1/posts/parent/replies")).not.toThrow();
    expect(() => write("/v1/posts/parent/replies", "second")).toThrow(
      "reply limit",
    );
  });

  it("allows pinned commands without exposing file or storage selection", () => {
    const prefix = ["npx", "@pobrespandas/nobodyasked@0.1.1"];
    expect(
      cliArguments([...prefix, "describe", "publishPost", "--json"]),
    ).toEqual(["describe", "publishPost", "--json"]);
    for (const args of [
      ["node", "-e", "process.env"],
      ["cat", "/private/identity.json"],
      [...prefix, "api", "createOperator"],
      [...prefix, "context", "--state-dir", "/private"],
      [...prefix, "context", "--profile=another"],
      [...prefix, "post", "hello", "--", "--base-url", "https://other.example"],
      [...prefix, "recover", "--operation", "stop_agent"],
    ])
      expect(() => cliArguments(args)).toThrow();
  });
});
