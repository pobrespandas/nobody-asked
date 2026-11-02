export interface ApiDeployment {
  readonly projectId: string;
  readonly region: string;
  readonly databaseId: string;
  readonly service: string;
  readonly serviceAccount: string;
  readonly operatorChallengeFromEmail: string;
  readonly resendApiKeySecret: string;
}

export function createDeployArguments(
  input: ApiDeployment,
  image: string,
  revision: string,
): string[] {
  validate(input, image, revision);
  return [
    "run",
    "deploy",
    input.service,
    "--project",
    input.projectId,
    "--region",
    input.region,
    "--image",
    image,
    "--revision-suffix",
    revision,
    "--service-account",
    input.serviceAccount,
    "--no-allow-unauthenticated",
    "--set-env-vars",
    `NOBODY_ASKED_GCP_PROJECT_ID=${input.projectId},FIRESTORE_DATABASE_ID=${input.databaseId},OPERATOR_CHALLENGE_FROM_EMAIL=${input.operatorChallengeFromEmail}`,
    "--set-secrets",
    `RESEND_API_KEY=${input.resendApiKeySecret}`,
    "--quiet",
  ];
}

function validate(input: ApiDeployment, image: string, revision: string): void {
  for (const [name, value] of Object.entries(input)) {
    if (!value || value.includes("REQUIRED"))
      throw new Error(`${name} must be explicit.`);
  }
  if (input.projectId === "querelo-prod")
    throw new Error("projectId is outside this product boundary.");
  if (input.databaseId === "(default)")
    throw new Error("databaseId must name a non-default database.");
  if (
    !/^[^\s@,=]+@[^\s@,=]+\.[^\s@,=]+$/.test(input.operatorChallengeFromEmail)
  )
    throw new Error("operatorChallengeFromEmail must be an email address.");
  if (!/^[a-z][a-z0-9-]*:[1-9][0-9]*$/.test(input.resendApiKeySecret))
    throw new Error("resendApiKeySecret must name a numeric secret version.");
  if (
    !input.serviceAccount.endsWith(
      `@${input.projectId}.iam.gserviceaccount.com`,
    )
  ) {
    throw new Error("serviceAccount must belong to projectId.");
  }
  if (!/@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("image must use an immutable sha256 digest.");
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(revision))
    throw new Error("revision must be a safe Cloud Run suffix.");
}
