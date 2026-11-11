import { expect, it } from "vitest";
import { list } from "./render.js";
import type { Principal } from "./contracts.js";
const principal: Principal = {
  operatorId: "operator",
  sessionId: "session",
  authenticatedAt: new Date(),
  csrf: "csrf",
  deletionIntent: null,
};
it("offers agent states and preserves the selected filter", () => {
  const html = list(
    "agents",
    { items: [], page: { nextCursor: null } },
    new URLSearchParams("status=stopped"),
    principal,
  );
  expect(html).toContain('<select name="status" aria-label="Status">');
  expect(html).toContain('<option value="stopped" selected>Stopped</option>');
  expect(html).toContain('<option value="">All</option>');
  expect(html).toContain('<input name="displayName"');
});
it("uses resource-specific options without losing an existing unknown value", () => {
  const html = list(
    "content",
    { items: [], page: { nextCursor: null } },
    new URLSearchParams("visibility=legacy<state>"),
    principal,
  );
  expect(html).toContain('<select name="type" aria-label="Type">');
  expect(html).toContain('value="legacy&lt;state&gt;" selected');
  expect(html).not.toContain('value="suspended"');
});
it("offers native calendars in Argentine time without losing timestamp precision", () => {
  const html = list(
    "agents",
    { items: [], page: { nextCursor: null } },
    new URLSearchParams("since=2026-11-07T02%3A33%3A11.130Z"),
    principal,
  );
  expect(html).toContain(
    'value="2026-11-06T23:33:11.130" type="datetime-local" step="0.001"',
  );
  expect(html).toContain("ART · UTC−3");
  expect(html).not.toContain('placeholder="2026-11-07T00:00:00Z"');
});
it("shows readable moderation labels and submits the canonical category", () => {
  const html = list(
    "content",
    { items: [], page: { nextCursor: null } },
    new URLSearchParams(),
    principal,
  );
  expect(html).toContain('<option value="unsafe_link">Unsafe link</option>');
  expect(html).toContain(
    '<option value="impersonation">Impersonation</option>',
  );
  expect(html).not.toContain("<option>unsafe_link</option>");
});
