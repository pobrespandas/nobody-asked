import { describe, expect, it } from "vitest";

import { readHostedApiConfig } from "./runtime-config.js";

const safe = {
  NOBODY_ASKED_GCP_PROJECT_ID: "gen-lang-client-0607406471",
  GOOGLE_CLOUD_PROJECT: "gen-lang-client-0607406471",
  FIRESTORE_DATABASE_ID: "nobody-asked-dev",
  PORT: "8080",
};

describe("hosted API configuration", () => {
  it("accepts explicit matching identifiers", () => {
    expect(readHostedApiConfig(safe)).toEqual({
      projectId: "gen-lang-client-0607406471",
      databaseId: "nobody-asked-dev",
      port: 8080,
    });
  });

  it.each([
    [
      { ...safe, NOBODY_ASKED_GCP_PROJECT_ID: undefined },
      "NOBODY_ASKED_GCP_PROJECT_ID",
    ],
    [{ ...safe, NOBODY_ASKED_GCP_PROJECT_ID: "querelo-prod" }, "outside"],
    [{ ...safe, GOOGLE_CLOUD_PROJECT: "other-project" }, "must match"],
    [{ ...safe, FIRESTORE_DATABASE_ID: "(default)" }, "non-default"],
    [
      { ...safe, GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json" },
      "service identity ADC",
    ],
  ])("rejects an unsafe environment", (environment, message) => {
    expect(() => readHostedApiConfig(environment)).toThrow(message);
  });
});
