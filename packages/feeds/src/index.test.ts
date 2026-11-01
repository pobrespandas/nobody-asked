import { describe, expect, it } from "vitest";

import {
  InvalidFeedCursorError,
  InvalidFeedLimitError,
  InvalidFeedRecordError,
  readPersonalFeed,
  readPublicTimeline,
  type FeedRecord,
} from "./index.js";

interface TestRecord extends FeedRecord {
  readonly text: string;
}

const records = Object.freeze([
  record("post-1", "agent-a", "2026-11-01T10:00:00.000Z"),
  record("post-3", "agent-b", "2026-11-01T11:00:00.000Z"),
  record("post-2", "agent-a", "2026-11-01T11:00:00.000Z"),
  record("post-4", "agent-c", "2026-11-01T09:00:00.000Z"),
]);

describe("public timeline", () => {
  it("orders records by publication time and immutable ID", () => {
    const input = [...records];

    const page = readPublicTimeline(input, { limit: 10 });

    expect(page.items.map(({ id }) => id)).toEqual([
      "post-3",
      "post-2",
      "post-1",
      "post-4",
    ]);
    expect(input).toEqual(records);
    expect(page.nextCursor).toBeNull();
  });

  it("uses opaque cursors for stable pages", () => {
    const firstPage = readPublicTimeline(records, { limit: 2 });

    expect(firstPage.items.map(({ id }) => id)).toEqual(["post-3", "post-2"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(firstPage.nextCursor).not.toContain("post-2");

    const secondPage = readPublicTimeline(records, {
      limit: 2,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.items.map(({ id }) => id)).toEqual(["post-1", "post-4"]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("does not repeat a record when newer records arrive", () => {
    const firstPage = readPublicTimeline(records, { limit: 2 });
    const changedRecords = [
      record("post-5", "agent-d", "2026-11-01T12:00:00.000Z"),
      ...records,
    ];

    const secondPage = readPublicTimeline(changedRecords, {
      limit: 10,
      cursor: firstPage.nextCursor,
    });

    expect(secondPage.items.map(({ id }) => id)).toEqual(["post-1", "post-4"]);
  });
});

describe("personal feed", () => {
  it("includes records from followed agents only", () => {
    const page = readPersonalFeed(records, {
      limit: 10,
      followedAgentIds: new Set(["agent-a", "agent-c"]),
    });

    expect(page.items.map(({ id }) => id)).toEqual([
      "post-2",
      "post-1",
      "post-4",
    ]);
  });

  it("applies the current follow set when a cursor is reused", () => {
    const firstPage = readPersonalFeed(records, {
      limit: 1,
      followedAgentIds: ["agent-a", "agent-b"],
    });

    const secondPage = readPersonalFeed(records, {
      limit: 10,
      cursor: firstPage.nextCursor,
      followedAgentIds: ["agent-a"],
    });

    expect(secondPage.items.map(({ id }) => id)).toEqual(["post-2", "post-1"]);
  });
});

describe("feed input validation", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects the limit %s", (limit) => {
    expect(() => readPublicTimeline(records, { limit })).toThrow(
      InvalidFeedLimitError,
    );
  });

  it("rejects an invalid cursor", () => {
    expect(() =>
      readPublicTimeline(records, { limit: 2, cursor: "not-a-cursor" }),
    ).toThrow(InvalidFeedCursorError);
  });

  it("rejects duplicate immutable IDs", () => {
    expect(() =>
      readPublicTimeline([records[0]!, records[0]!], { limit: 2 }),
    ).toThrow(InvalidFeedRecordError);
  });

  it("rejects an invalid publication time", () => {
    expect(() =>
      readPublicTimeline(
        [
          {
            id: "post-invalid",
            authorId: "agent-a",
            publishedAt: new Date(Number.NaN),
            text: "Invalid",
          },
        ],
        { limit: 2 },
      ),
    ).toThrow(InvalidFeedRecordError);
  });
});

function record(id: string, authorId: string, publishedAt: string): TestRecord {
  return Object.freeze({
    id,
    authorId,
    publishedAt: new Date(publishedAt),
    text: id,
  });
}
