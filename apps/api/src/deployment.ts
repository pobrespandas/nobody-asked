export interface ApiDeployment {
  readonly projectId: string;
  readonly region: string;
  readonly databaseId: string;
  readonly service: string;
  readonly serviceAccount: string;
  readonly operatorChallengeFromEmail: string;
  readonly operatorMailProvider?: "resend" | "icloud";
  readonly resendApiKeySecret?: string;
  readonly icloudSmtpCredentialsSecret?: string;
}

export function createDeployArguments(
  input: ApiDeployment,
  image: string,
  revision: string,
): string[] {
  validate(input, image, revision);
  const provider = input.operatorMailProvider ?? "resend";
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
    "--no-traffic",
    "--update-env-vars",
    `NOBODY_ASKED_GCP_PROJECT_ID=${input.projectId},FIRESTORE_DATABASE_ID=${input.databaseId},OPERATOR_CHALLENGE_FROM_EMAIL=${input.operatorChallengeFromEmail},OPERATOR_MAIL_PROVIDER=${provider}`,
    "--update-secrets",
    provider === "icloud"
      ? `ICLOUD_SMTP_CREDENTIALS=${input.icloudSmtpCredentialsSecret}`
      : `RESEND_API_KEY=${input.resendApiKeySecret}`,
    "--remove-secrets",
    provider === "icloud" ? "RESEND_API_KEY" : "ICLOUD_SMTP_CREDENTIALS",
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
  const provider = input.operatorMailProvider ?? "resend";
  if (provider !== "resend" && provider !== "icloud")
    throw new Error("operatorMailProvider must be resend or icloud.");
  if (
    provider === "icloud" &&
    input.operatorChallengeFromEmail !== "nobodyasked@pobrespandas.com"
  )
    throw new Error("The iCloud sender must be nobodyasked@pobrespandas.com.");
  const secret =
    provider === "icloud"
      ? input.icloudSmtpCredentialsSecret
      : input.resendApiKeySecret;
  if (!secret || !/^[a-z][a-z0-9-]*:[1-9][0-9]*$/.test(secret))
    throw new Error(
      "The selected mail secret must name a numeric secret version.",
    );
  if (
    (provider === "icloud" && input.resendApiKeySecret) ||
    (provider === "resend" && input.icloudSmtpCredentialsSecret)
  )
    throw new Error("Configure only the selected mail provider secret.");
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
