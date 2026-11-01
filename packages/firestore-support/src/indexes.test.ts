import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

interface IndexConfiguration {
  readonly indexes: readonly {
    readonly collectionGroup: string;
    readonly fields: readonly { readonly fieldPath: string }[];
  }[];
  readonly fieldOverrides: readonly {
    readonly collectionGroup: string;
    readonly fieldPath: string;
    readonly indexes: readonly unknown[];
    readonly ttl?: boolean;
  }[];
}

async function readIndexConfiguration(): Promise<IndexConfiguration> {
  return JSON.parse(
    await readFile("firestore.indexes.json", "utf8"),
  ) as IndexConfiguration;
}

describe("Firestore index boundaries", () => {
  it("exempts every contracted sensitive or long field", async () => {
    const configuration = await readIndexConfiguration();
    const exemptions = configuration.fieldOverrides.map(
      ({ collectionGroup, fieldPath, indexes }) => ({
        collectionGroup,
        fieldPath,
        indexes,
      }),
    );

    expect(exemptions).toEqual(
      expect.arrayContaining([
        exemption("agentProfiles", "description"),
        exemption("operatorInvitations", "secretDigest"),
        exemption("operatorChallenges", "secretDigest"),
        exemption("operatorSessions", "secretDigest"),
        exemption("credentials", "secretDigest"),
        exemption("publicItems", "text"),
        exemption("moderationActions", "internalNote"),
        exemption("auditRecords", "details.requestOrigin"),
        exemption("idempotencyRecords", "keyHash"),
        exemption("idempotencyRecords", "requestFingerprint"),
        exemption("idempotencyRecords", "response"),
        exemption("rateLimitBuckets", "expireAt"),
      ]),
    );
  });

  it("configures rate-limit expiry without indexing the TTL field", async () => {
    const configuration = await readIndexConfiguration();
    expect(
      configuration.fieldOverrides.find(
        ({ collectionGroup, fieldPath }) =>
          collectionGroup === "rateLimitBuckets" && fieldPath === "expireAt",
      ),
    ).toEqual({
      collectionGroup: "rateLimitBuckets",
      fieldPath: "expireAt",
      ttl: true,
      indexes: [],
    });
  });

  it("uses resolvedAt as the only Report resolution field", async () => {
    const configuration = await readIndexConfiguration();
    const reportIndexes = configuration.indexes.filter(
      (index) => index.collectionGroup === "reports",
    );
    const fieldPaths = reportIndexes.flatMap((index) =>
      index.fields.map((field) => field.fieldPath),
    );

    expect(fieldPaths).toContain("resolvedAt");
    expect(fieldPaths).not.toContain("state");
    expect(fieldPaths).not.toContain("status");
  });

  it("uses the current Firestore adapter field names", async () => {
    const configuration = await readIndexConfiguration();
    const pathsFor = (collectionGroup: string) =>
      configuration.indexes
        .filter((index) => index.collectionGroup === collectionGroup)
        .flatMap((index) => index.fields.map((field) => field.fieldPath));

    expect(pathsFor("publicItems")).toContain("authorId");
    expect(pathsFor("follows")).toEqual(
      expect.arrayContaining(["followedId", "followerId", "followedAt"]),
    );
    expect(pathsFor("idempotencyRecords")).toEqual([]);
  });
});

function exemption(collectionGroup: string, fieldPath: string) {
  return { collectionGroup, fieldPath, indexes: [] };
}
