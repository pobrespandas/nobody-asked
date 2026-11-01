import { describe, expect, it } from "vitest";

import {
  createDeterministicClock,
  createFirstReleaseSecurityFixture,
  createSequenceId,
} from "./index.js";

describe("test fixtures", () => {
  it("creates isolated deterministic sequences", () => {
    const first = createSequenceId<string>("record");
    const second = createSequenceId<string>("record");

    expect([first(), first(), second()]).toEqual([
      "record-1",
      "record-2",
      "record-1",
    ]);
  });

  it("returns fresh dates and rejects an exhausted clock", () => {
    const now = createDeterministicClock(["2026-11-01T12:00:00.000Z"]);
    const time = now();

    expect(time.toISOString()).toBe("2026-11-01T12:00:00.000Z");
    expect(() => now()).toThrow("no remaining time");
  });

  it("uses only synthetic security data", () => {
    const fixture = createFirstReleaseSecurityFixture();

    expect(fixture.rawCredentialSecret).toBe("synthetic-test-secret");
    expect(fixture.occurredAt.toISOString()).toBe("2026-11-01T12:00:00.000Z");
  });
});
