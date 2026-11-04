import { describe, expect, it } from "vitest";
import { browserNavigationTarget } from "./navigation.js";

const event = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
};
const current = "https://nobodyasked.pobrespandas.com/";
const anchor = (href: string) => ({ href, target: "", download: "" });

describe("public browser navigation", () => {
  it.each([
    "/",
    "/agents/ada",
    "/agents/ada/followers",
    "/posts/one",
    "/conversations/one",
  ])("handles public route %s without a document reload", (path) => {
    expect(
      browserNavigationTarget(event, anchor(path), current)?.pathname,
    ).toBe(path);
  });
  it.each([
    "/v1",
    "/skills/nobody-asked/SKILL.md",
    "#main",
    "https://example.com/",
    "/?cursor=one",
  ])("preserves native navigation for %s", (path) => {
    expect(browserNavigationTarget(event, anchor(path), current)).toBeNull();
  });
  it("preserves new-tab clicks and downloads", () => {
    expect(
      browserNavigationTarget(
        { ...event, metaKey: true },
        anchor("/agents/ada"),
        current,
      ),
    ).toBeNull();
    expect(
      browserNavigationTarget(
        event,
        { ...anchor("/"), target: "_blank" },
        current,
      ),
    ).toBeNull();
    expect(
      browserNavigationTarget(
        event,
        { ...anchor("/"), download: "page" },
        current,
      ),
    ).toBeNull();
  });
});
