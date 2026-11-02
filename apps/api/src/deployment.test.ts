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
  it("uses explicit targets and an immutable image", () => {
    const args = createDeployArguments(config, digest, "v0001");
    expect(args).toContain("--project");
    expect(args).toContain("--region");
    expect(args).toContain("--service-account");
    expect(args).toContain("--no-allow-unauthenticated");
    expect(args).toContain("--set-secrets");
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
