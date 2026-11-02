import { describe, expect, it } from "vitest";

import {
  type FirestoreSmokeDatabase,
  type FirestoreSmokeQuery,
  RemoteFirestoreSmokeError,
  runRemoteFirestoreIndexSmoke,
  validateRemoteSmokeEnvironment,
} from "./remote-index-smoke.js";

const validEnvironment = {
  ALLOW_REMOTE_FIRESTORE_SMOKE: "1",
  REMOTE_FIRESTORE_PROJECT_ID: "nobody-asked-staging",
  REMOTE_FIRESTORE_DATABASE_ID: "nobody-asked-staging",
  GOOGLE_CLOUD_PROJECT: "nobody-asked-staging",
};

describe("remote smoke guardrails", () => {
  it.each([
    [
      { ...validEnvironment, ALLOW_REMOTE_FIRESTORE_SMOKE: undefined },
      "remote_smoke_opt_in_required",
    ],
    [
      { ...validEnvironment, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
      "remote_smoke_emulator_forbidden",
    ],
    [{ ALLOW_REMOTE_FIRESTORE_SMOKE: "1" }, "remote_smoke_project_required"],
    [
      { ...validEnvironment, GOOGLE_CLOUD_PROJECT: "another-project" },
      "remote_smoke_project_mismatch",
    ],
    [
      {
        ...validEnvironment,
        REMOTE_FIRESTORE_PROJECT_ID: "demo-local",
        GOOGLE_CLOUD_PROJECT: "demo-local",
      },
      "remote_smoke_project_forbidden",
    ],
    [
      { ...validEnvironment, REMOTE_FIRESTORE_DATABASE_ID: undefined },
      "remote_smoke_database_required",
    ],
    [
      { ...validEnvironment, REMOTE_FIRESTORE_DATABASE_ID: "(default)" },
      "remote_smoke_database_forbidden",
    ],
    [
      { ...validEnvironment, REMOTE_FIRESTORE_DATABASE_ID: "invalid_name" },
      "remote_smoke_database_forbidden",
    ],
    [
      { ...validEnvironment, REMOTE_FIRESTORE_DATABASE_ID: "querelo-prod" },
      "remote_smoke_database_forbidden",
    ],
    [
      {
        ...validEnvironment,
        REMOTE_FIRESTORE_PROJECT_ID: "querelo-prod",
        GOOGLE_CLOUD_PROJECT: "querelo-prod",
      },
      "remote_smoke_project_forbidden",
    ],
    [
      {
        ...validEnvironment,
        REMOTE_FIRESTORE_PROJECT_ID: "querelo-prod-shadow",
        GOOGLE_CLOUD_PROJECT: "querelo-prod-shadow",
      },
      "remote_smoke_project_forbidden",
    ],
  ] as const)("rejects unsafe environment %#", (environment, code) => {
    expect(() => validateRemoteSmokeEnvironment(environment)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("accepts explicit matching non-production project IDs", () => {
    expect(validateRemoteSmokeEnvironment(validEnvironment)).toEqual({
      projectId: "nobody-asked-staging",
      databaseId: "nobody-asked-staging",
    });
  });
});

describe("remote index query shapes", () => {
  it("runs every documented query with limit one and returns no data", async () => {
    const fake = new FakeFirestore();
    const now = new Date("2026-11-01T12:00:00.000Z");

    const summary = await runRemoteFirestoreIndexSmoke(fake, now);

    expect(summary).toEqual({ status: "passed", queryCount: 9 });
    expect(summary).not.toHaveProperty("data");
    expect(fake.executed).toEqual([
      shape("publicItems", [
        ["where", "visibility", "==", "visible"],
        ["orderBy", "publishedAt", "desc"],
        ["orderBy", "id", "desc"],
      ]),
      shape("publicItems", [
        ["where", "authorId", "==", "remote-index-smoke-missing-id"],
        ["where", "visibility", "==", "visible"],
        ["orderBy", "publishedAt", "desc"],
        ["orderBy", "id", "desc"],
      ]),
      shape("publicItems", [
        ["where", "authorId", "in", ["remote-index-smoke-missing-id"]],
        ["where", "visibility", "==", "visible"],
        ["orderBy", "publishedAt", "desc"],
        ["orderBy", "id", "desc"],
      ]),
      shape("publicItems", [
        ["where", "conversationRootId", "==", "remote-index-smoke-missing-id"],
        ["where", "visibility", "==", "visible"],
        ["orderBy", "publishedAt", "asc"],
        ["orderBy", "id", "asc"],
      ]),
      shape("follows", [
        ["where", "followerId", "==", "remote-index-smoke-missing-id"],
        ["orderBy", "followedAt", "desc"],
        ["orderBy", "followedId", "asc"],
      ]),
      shape("follows", [
        ["where", "followedId", "==", "remote-index-smoke-missing-id"],
        ["orderBy", "followedAt", "desc"],
        ["orderBy", "followerId", "asc"],
      ]),
      shape("reports", [
        ["where", "resolvedAt", "==", null],
        ["orderBy", "reportedAt", "asc"],
        ["orderBy", "id", "asc"],
      ]),
      shape("auditRecords", [
        ["where", "subjectType", "==", "agent"],
        ["where", "subjectId", "==", "remote-index-smoke-missing-id"],
        ["orderBy", "createdAt", "desc"],
        ["orderBy", "id", "desc"],
      ]),
      shape("auditRecords", [
        ["where", "expireAt", "<=", now],
        ["orderBy", "expireAt", "asc"],
        ["orderBy", "id", "asc"],
      ]),
    ]);
  });

  it("returns a stable query error without the remote error text", async () => {
    const fake = new FakeFirestore(
      4,
      new Error("credential and document data"),
    );

    await expect(runRemoteFirestoreIndexSmoke(fake)).rejects.toEqual(
      new RemoteFirestoreSmokeError("remote_smoke_query_failed", "following"),
    );
  });
});

type Operation = readonly [string, ...unknown[]];

function shape(collection: string, operations: readonly Operation[]) {
  return { collection, operations: [...operations, ["limit", 1]] };
}

class FakeFirestore implements FirestoreSmokeDatabase {
  readonly executed: { collection: string; operations: Operation[] }[] = [];
  #queryIndex = 0;

  constructor(
    private readonly failingIndex: number | null = null,
    private readonly failure: Error | null = null,
  ) {}

  collection(name: string): FirestoreSmokeQuery {
    const queryIndex = this.#queryIndex++;
    const operations: Operation[] = [];
    const query: FirestoreSmokeQuery = {
      where: (field, operator, value) => {
        operations.push(["where", field, operator, value]);
        return query;
      },
      orderBy: (field, direction) => {
        operations.push(["orderBy", field, direction]);
        return query;
      },
      limit: (value) => {
        operations.push(["limit", value]);
        return query;
      },
      get: async () => {
        this.executed.push({ collection: name, operations });
        if (queryIndex === this.failingIndex) throw this.failure;
        return Object.freeze({});
      },
    };
    return query;
  }
}
