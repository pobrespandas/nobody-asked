import { describe, expect, it } from "vitest";

import {
  type RuntimeSecretConfigError,
  parseHostedRuntimeSecretConfig,
} from "../../tools/runtime-secrets.js";

const validConfig = {
  formatVersion: 1,
  projectId: "nobody-asked-staging",
  runtimeServiceAccount:
    "nobody-asked-api@nobody-asked-staging.iam.gserviceaccount.com",
  bindings: [
    {
      environmentVariable: "RUNTIME_TEST_SECRET",
      secretVersion:
        "projects/nobody-asked-staging/secrets/runtime-test-secret/versions/7",
    },
  ],
} as const;

describe("hosted runtime secret configuration", () => {
  it("accepts a numeric secret version and returns only references", () => {
    expect(parseHostedRuntimeSecretConfig(validConfig)).toEqual(validConfig);
  });

  it.each([
    [
      { ...validConfig, projectId: "demo-local" },
      "runtime_secret_project_invalid",
    ],
    [
      { ...validConfig, projectId: "querelo-prod" },
      "runtime_secret_project_invalid",
    ],
    [
      {
        ...validConfig,
        runtimeServiceAccount:
          "nobody-asked-api@other-project.iam.gserviceaccount.com",
      },
      "runtime_secret_identity_invalid",
    ],
    [{ ...validConfig, bindings: [] }, "runtime_secret_bindings_required"],
    [
      {
        ...validConfig,
        bindings: [
          {
            ...validConfig.bindings[0],
            environmentVariable: "GOOGLE_APPLICATION_CREDENTIALS",
          },
        ],
      },
      "runtime_secret_environment_invalid",
    ],
    [
      {
        ...validConfig,
        bindings: [validConfig.bindings[0], validConfig.bindings[0]],
      },
      "runtime_secret_environment_invalid",
    ],
    [
      {
        ...validConfig,
        bindings: [
          {
            ...validConfig.bindings[0],
            secretVersion:
              "projects/nobody-asked-staging/secrets/runtime-test-secret/versions/latest",
          },
        ],
      },
      "runtime_secret_version_invalid",
    ],
    [
      {
        ...validConfig,
        bindings: [
          {
            ...validConfig.bindings[0],
            secretVersion:
              "projects/other-project/secrets/runtime-test-secret/versions/7",
          },
        ],
      },
      "runtime_secret_version_invalid",
    ],
    [
      {
        ...validConfig,
        bindings: [{ ...validConfig.bindings[0], value: "raw-secret" }],
      },
      "runtime_secret_shape_invalid",
    ],
    [
      { ...validConfig, privateKey: "key-material" },
      "runtime_secret_shape_invalid",
    ],
  ] as const)("rejects unsafe configuration %#", (input, code) => {
    expect(() => parseHostedRuntimeSecretConfig(input)).toThrowError(
      expect.objectContaining<Partial<RuntimeSecretConfigError>>({ code }),
    );
  });
});
