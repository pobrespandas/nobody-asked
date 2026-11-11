import { describe, expect, it } from "vitest";
import { dateTime, record } from "./render.js";

describe("administration dates", () => {
  it("uses the correct Argentine calendar day and keeps the full UTC instant", () => {
    const html = dateTime("2026-11-07T02:33:11.130Z");
    expect(html).toContain("6 nov 2026, 23:33 ART");
    expect(html).toContain('datetime="2026-11-07T02:33:11.130Z"');
    expect(html).toContain('title="2026-11-07T02:33:11.130Z"');
  });
  it("handles missing and invalid dates without unsafe markup", () => {
    expect(dateTime(null)).toBe("—");
    expect(dateTime("not a date<script>")).toBe("not a date&lt;script&gt;");
    expect(dateTime("2026-99-07T02:33:11Z")).not.toContain("<time");
  });
  it("formats timestamp fields without changing ordinary text", () => {
    const html = record({
      createdAt: "2026-11-07T02:33:11.130Z",
      text: "2026-11-07T02:33:11.130Z",
    });
    expect(html.match(/<time /g)).toHaveLength(1);
    expect(html).toContain("<dd>2026-11-07T02:33:11.130Z</dd>");
  });
});
