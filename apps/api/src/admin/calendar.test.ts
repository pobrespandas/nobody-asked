import { expect, it } from "vitest";
import { browserFilters, calendarValue } from "./calendar.js";
it("round trips a calendar boundary without using the server time zone", () => {
  const value = "2026-11-06T23:33:11.130";
  const input = new URLSearchParams({ since: value });
  const normalized = browserFilters(input);
  expect(new Date(normalized.get("since")!).toISOString()).toBe(
    "2026-11-07T02:33:11.130Z",
  );
  expect(calendarValue(normalized.get("since")!)).toBe(value);
  expect(input.get("since")).toBe(value);
});
it("preserves explicit offsets, repeated parameters and empty bounds", () => {
  const input = new URLSearchParams(
    "since=2026-11-07T02:33:11Z&status=active&status=stopped&until=",
  );
  const normalized = browserFilters(input);
  expect(normalized.toString()).toBe(input.toString());
  expect(calendarValue("")).toBe("");
});
