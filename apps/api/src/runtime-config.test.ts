import { describe, expect, it } from "vitest";

import { readHostedApiConfig } from "./runtime-config.js";

const safe = {
  NOBODY_ASKED_GCP_PROJECT_ID: "gen-lang-client-0607406471",
  GOOGLE_CLOUD_PROJECT: "gen-lang-client-0607406471",
  FIRESTORE_DATABASE_ID: "nobody-asked-dev",
  PORT: "8080",
  RESEND_API_KEY: "resend-secret",
  OPERATOR_CHALLENGE_FROM_EMAIL: "access@nobodyasked.pobrespandas.com",
};

describe("hosted API configuration", () => {
  it("accepts explicit matching identifiers", () => {
    expect(readHostedApiConfig(safe)).toEqual({
      projectId: "gen-lang-client-0607406471",
      databaseId: "nobody-asked-dev",
      port: 8080,
      operatorMail: {
        provider: "resend",
        apiKey: "resend-secret",
        fromEmail: "access@nobodyasked.pobrespandas.com",
      },
    });
  });

  const icloud = {
    ...safe,
    OPERATOR_MAIL_PROVIDER: "icloud",
    OPERATOR_CHALLENGE_FROM_EMAIL: "nobodyasked@pobrespandas.com",
    RESEND_API_KEY: undefined,
    ICLOUD_SMTP_CREDENTIALS: JSON.stringify({
      user: "andres.tobelem@icloud.com",
      appPassword: "test-app-password",
    }),
  };

  it("selects iCloud without requiring or using a Resend key", () => {
    expect(readHostedApiConfig(icloud).operatorMail).toEqual({
      provider: "icloud",
      fromEmail: "nobodyasked@pobrespandas.com",
      credentials: {
        user: "andres.tobelem@icloud.com",
        appPassword: "test-app-password",
      },
    });
  });

  it.each([
    { ...icloud, OPERATOR_MAIL_PROVIDER: "unknown" },
    { ...icloud, ICLOUD_SMTP_CREDENTIALS: undefined },
    { ...icloud, OPERATOR_CHALLENGE_FROM_EMAIL: "other@pobrespandas.com" },
    {
      ...icloud,
      ICLOUD_SMTP_CREDENTIALS: '{"user":"private","appPassword":"private"}',
    },
  ])("fails closed for invalid iCloud configuration", (environment) => {
    expect(() => readHostedApiConfig(environment)).toThrow();
  });

  it.each([
    [
      { ...safe, NOBODY_ASKED_GCP_PROJECT_ID: undefined },
      "NOBODY_ASKED_GCP_PROJECT_ID",
    ],
    [{ ...safe, NOBODY_ASKED_GCP_PROJECT_ID: "querelo-prod" }, "outside"],
    [{ ...safe, GOOGLE_CLOUD_PROJECT: "other-project" }, "must match"],
    [{ ...safe, FIRESTORE_DATABASE_ID: "(default)" }, "non-default"],
    [{ ...safe, RESEND_API_KEY: undefined }, "RESEND_API_KEY"],
    [
      { ...safe, OPERATOR_CHALLENGE_FROM_EMAIL: "invalid" },
      "must be an email address",
    ],
    [
      { ...safe, GOOGLE_APPLICATION_CREDENTIALS: "/tmp/key.json" },
      "service identity ADC",
    ],
  ])("rejects an unsafe environment", (environment, message) => {
    expect(() => readHostedApiConfig(environment)).toThrow(message);
  });
});
