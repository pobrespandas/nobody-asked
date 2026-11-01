export const feedsModule = "feeds" as const;

export type FeedCursor = string & { readonly __brand: "FeedCursor" };

export interface FeedRecord {
  readonly id: string;
  readonly authorId: string;
  readonly publishedAt: Date;
}

export interface FeedPage<T extends FeedRecord> {
  readonly items: readonly T[];
  readonly nextCursor: FeedCursor | null;
}

export interface FeedPageOptions {
  readonly limit: number;
  readonly cursor?: string | null;
}

export interface PersonalFeedOptions extends FeedPageOptions {
  readonly followedAgentIds: ReadonlySet<string> | readonly string[];
}

interface CursorPosition {
  readonly version: 1;
  readonly publishedAt: number;
  readonly id: string;
}

export class InvalidFeedCursorError extends Error {
  readonly code = "invalid_feed_cursor";

  constructor() {
    super("The feed cursor is invalid.");
    this.name = "InvalidFeedCursorError";
  }
}

export class InvalidFeedLimitError extends Error {
  readonly code = "invalid_feed_limit";

  constructor() {
    super("The feed limit must be a positive integer.");
    this.name = "InvalidFeedLimitError";
  }
}

export class InvalidFeedRecordError extends Error {
  readonly code = "invalid_feed_record";

  constructor(message: string) {
    super(message);
    this.name = "InvalidFeedRecordError";
  }
}

export function readPublicTimeline<T extends FeedRecord>(
  records: readonly T[],
  options: FeedPageOptions,
): FeedPage<T> {
  return paginate(records, options);
}

export function readPersonalFeed<T extends FeedRecord>(
  records: readonly T[],
  options: PersonalFeedOptions,
): FeedPage<T> {
  const followedAgentIds = new Set(options.followedAgentIds);
  const followedRecords = records.filter((record) =>
    followedAgentIds.has(record.authorId),
  );

  return paginate(followedRecords, options);
}

function paginate<T extends FeedRecord>(
  records: readonly T[],
  options: FeedPageOptions,
): FeedPage<T> {
  validateLimit(options.limit);
  validateRecords(records);

  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const orderedRecords = [...records].sort(compareRecords);
  const remainingRecords = cursor
    ? orderedRecords.filter((record) => isAfterCursor(record, cursor))
    : orderedRecords;
  const items = remainingRecords.slice(0, options.limit);
  const lastItem = items.at(-1);
  const nextCursor =
    lastItem && remainingRecords.length > items.length
      ? encodeCursor(positionOf(lastItem))
      : null;

  return Object.freeze({
    items: Object.freeze(items),
    nextCursor,
  });
}

function compareRecords(left: FeedRecord, right: FeedRecord): number {
  const timeDifference =
    right.publishedAt.getTime() - left.publishedAt.getTime();

  if (timeDifference !== 0) {
    return timeDifference;
  }

  if (left.id === right.id) {
    return 0;
  }

  return left.id > right.id ? -1 : 1;
}

function isAfterCursor(record: FeedRecord, cursor: CursorPosition): boolean {
  const recordTime = record.publishedAt.getTime();

  return (
    recordTime < cursor.publishedAt ||
    (recordTime === cursor.publishedAt && record.id < cursor.id)
  );
}

function positionOf(record: FeedRecord): CursorPosition {
  return {
    version: 1,
    publishedAt: record.publishedAt.getTime(),
    id: record.id,
  };
}

function encodeCursor(position: CursorPosition): FeedCursor {
  const bytes = new TextEncoder().encode(JSON.stringify(position));
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "") as FeedCursor;
}

function decodeCursor(cursor: string): CursorPosition {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new InvalidFeedCursorError();
    }

    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(base64 + padding);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));

    if (!isCursorPosition(value)) {
      throw new InvalidFeedCursorError();
    }

    return value;
  } catch (error) {
    if (error instanceof InvalidFeedCursorError) {
      throw error;
    }

    throw new InvalidFeedCursorError();
  }
}

function isCursorPosition(value: unknown): value is CursorPosition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    Object.keys(candidate).length === 3 &&
    candidate.version === 1 &&
    typeof candidate.publishedAt === "number" &&
    Number.isFinite(candidate.publishedAt) &&
    Number.isSafeInteger(candidate.publishedAt) &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0
  );
}

function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new InvalidFeedLimitError();
  }
}

function validateRecords(records: readonly FeedRecord[]): void {
  const ids = new Set<string>();

  for (const record of records) {
    if (!record.id) {
      throw new InvalidFeedRecordError("A feed record ID cannot be empty.");
    }

    if (ids.has(record.id)) {
      throw new InvalidFeedRecordError(
        `Feed record ID ${record.id} appears more than once.`,
      );
    }

    if (!Number.isFinite(record.publishedAt.getTime())) {
      throw new InvalidFeedRecordError(
        `Feed record ${record.id} has an invalid publication time.`,
      );
    }

    ids.add(record.id);
  }
}
