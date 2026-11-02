import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface RuntimeIdentityConfig {
  readonly formatVersion: number;
  readonly projectId: string;
  readonly databaseId: string;
  readonly serviceAccount: string;
  readonly projectRoles: readonly string[];
  readonly databaseRoles: readonly string[];
  readonly secretResources: readonly string[];
}

const config = JSON.parse(
  readFileSync(
    new URL("../../deploy/runtime-identity.json", import.meta.url),
    "utf8",
  ),
) as RuntimeIdentityConfig;

describe("hosted runtime identity", () => {
  it("uses one dedicated identity in the explicit project", () => {
    expect(config).toMatchObject({
      formatVersion: 1,
      projectId: "gen-lang-client-0607406471",
      databaseId: "nobody-asked-dev",
      serviceAccount:
        "nobody-asked-api-runtime@gen-lang-client-0607406471.iam.gserviceaccount.com",
    });
  });

  it("limits data and log roles to the required set", () => {
    expect(config.databaseRoles).toEqual(["roles/datastore.user"]);
    expect(config.projectRoles).toEqual(["roles/logging.logWriter"]);
    expect([...config.databaseRoles, ...config.projectRoles]).not.toEqual(
      expect.arrayContaining([
        "roles/owner",
        "roles/editor",
        "roles/datastore.indexAdmin",
        "roles/iam.serviceAccountAdmin",
        "roles/secretmanager.secretAccessor",
      ]),
    );
  });

  it("does not grant secret access when the runtime requires no secret", () => {
    expect(config.secretResources).toEqual([]);
  });
});
