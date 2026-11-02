export interface HostedApiConfig {
  readonly projectId: string;
  readonly databaseId: string;
  readonly port: number;
}

export function readHostedApiConfig(
  environment: NodeJS.ProcessEnv = process.env,
): HostedApiConfig {
  if (environment.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "Hosted API must use service identity ADC, not a key file.",
    );
  }

  const projectId = required(
    environment.NOBODY_ASKED_GCP_PROJECT_ID,
    "NOBODY_ASKED_GCP_PROJECT_ID",
  );
  if (projectId === "querelo-prod") {
    throw new Error(
      "The selected Google Cloud project is outside this product boundary.",
    );
  }
  if (
    environment.GOOGLE_CLOUD_PROJECT &&
    environment.GOOGLE_CLOUD_PROJECT !== projectId
  ) {
    throw new Error(
      "GOOGLE_CLOUD_PROJECT must match NOBODY_ASKED_GCP_PROJECT_ID.",
    );
  }

  const databaseId = required(
    environment.FIRESTORE_DATABASE_ID,
    "FIRESTORE_DATABASE_ID",
  );
  if (
    databaseId === "(default)" ||
    !/^[a-z][a-z0-9-]{2,61}[a-z0-9]$/.test(databaseId)
  ) {
    throw new Error("FIRESTORE_DATABASE_ID must name a non-default database.");
  }

  const port = Number(environment.PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535.");
  }
  return Object.freeze({ projectId, databaseId, port });
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value;
}
