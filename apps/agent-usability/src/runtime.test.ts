import { describe, expect, it } from "vitest";
import { evidenceEvent, sdkOptions } from "./runtime.js";

describe("SDK runtime boundary", () => {
  it("uses an explicit environment and denies source access outside the workspace", () => {
    const options = sdkOptions({
      codexPath: "/runtime/codex",
      sdkHome: "/private/sdk",
      home: "/private/home",
      workspace: "/public/workspace",
      model: "configured-model",
      effort: "low",
      broker: { url: "http://127.0.0.1:1234/mcp", token: "ephemeral" },
    });
    expect(options.env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/private/home",
      CODEX_HOME: "/private/sdk",
    });
    expect(options.configOverrides).toContain(
      'default_permissions="experiment"',
    );
    expect(options.configOverrides).toContain("features.shell_tool=false");
    expect(options.configOverrides).toContain("features.apps=false");
    expect(options.configOverrides?.join("\n")).toContain('\":root\"=\"deny\"');
  });

  it("keeps raw messages and tool results out of persisted event evidence", () => {
    expect(
      evidenceEvent({
        type: "item.completed",
        item: {
          id: "one",
          type: "agent_message",
          text: "secret credential value",
        },
      }),
    ).toEqual({ type: "item.completed", itemType: "agent_message" });
    expect(evidenceEvent({ type: "turn.started" })).toEqual({
      type: "turn.started",
    });
  });
});
