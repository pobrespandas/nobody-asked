import { describe, expect, it } from "vitest";
import { createDeployArguments, type ApiDeployment } from "./deployment.js";

const config: ApiDeployment = {
  projectId: "gen-lang-client-0607406471",
  region: "us-central1",
  databaseId: "nobody-asked-dev",
  service: "nobody-asked-api",
  serviceAccount:
    "nobody-asked-api-runtime@gen-lang-client-0607406471.iam.gserviceaccount.com",
  operatorChallengeFromEmail: "access@nobodyasked.pobrespandas.com",
  resendApiKeySecret: "resend-api-key:7",
};
const digest = `us-central1-docker.pkg.dev/example/api/api@sha256:${"a".repeat(64)}`;

describe("API deployment command", () => {
  it("binds only the selected numeric iCloud secret", () => {
    const { resendApiKeySecret, ...common } = config;
    void resendApiKeySecret;
    const input: ApiDeployment = {
      ...common,
      operatorMailProvider: "icloud",
      operatorChallengeFromEmail: "nobodyasked@pobrespandas.com",
      icloudSmtpCredentialsSecret: "nobody-asked-icloud-smtp:1",
    };
    const args = createDeployArguments(input, digest, "icloud-1");
    expect(args).toContain(
      "ICLOUD_SMTP_CREDENTIALS=nobody-asked-icloud-smtp:1",
    );
    expect(args.join(" ")).toContain("OPERATOR_MAIL_PROVIDER=icloud");
    expect(args[args.indexOf("--remove-secrets") + 1]).toBe("RESEND_API_KEY");
    expect(args).not.toContain("--set-secrets");
    expect(args).not.toContain("--set-env-vars");
    expect(args).toContain("--no-traffic");
    expect(args).not.toContain("--no-allow-unauthenticated");
    expect(args).not.toContain("--allow-unauthenticated");
    const { icloudSmtpCredentialsSecret, ...withoutSecret } = input;
    void icloudSmtpCredentialsSecret;
    for (const invalid of [
      {
        ...input,
        icloudSmtpCredentialsSecret: "nobody-asked-icloud-smtp:latest",
      },
      withoutSecret,
      { ...input, resendApiKeySecret: "resend-api-key:1" },
      { ...input, operatorChallengeFromEmail: "other@pobrespandas.com" },
    ])
      expect(() =>
        createDeployArguments(invalid, digest, "icloud-1"),
      ).toThrow();
  });
  it("uses explicit targets and an immutable image", () => {
    const args = createDeployArguments(config, digest, "v0001");
    expect(args).toContain("--project");
    expect(args).toContain("--region");
    expect(args).toContain("--service-account");
    expect(args).toContain("--no-traffic");
    expect(args).toContain("--update-secrets");
    expect(args).toContain("RESEND_API_KEY=resend-api-key:7");
    expect(args.join(" ")).toContain(
      "OPERATOR_CHALLENGE_FROM_EMAIL=access@nobodyasked.pobrespandas.com",
    );
    expect(args.join(" ")).not.toContain("config get");
  });

  it.each([
    [{ ...config, projectId: "querelo-prod" }, digest],
    [{ ...config, databaseId: "(default)" }, digest],
    [
      { ...config, serviceAccount: "api@other.iam.gserviceaccount.com" },
      digest,
    ],
    [config, "us-central1-docker.pkg.dev/example/api/api:latest"],
    [{ ...config, operatorChallengeFromEmail: "invalid" }, digest],
    [{ ...config, resendApiKeySecret: "resend-api-key:latest" }, digest],
  ])("rejects unsafe deployment input", (input, image) => {
    expect(() => createDeployArguments(input, image, "v0001")).toThrow();
  });
});
