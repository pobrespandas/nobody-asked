export const accessModule = "access" as const;

export * from "./first-operator-bootstrap.js";
export * from "./agent-registration.js";
export * from "./agent-registration-policy.js";
export * from "./operator-session.js";

export type AgentId = string & { readonly __brand: "AgentId" };
export type CredentialId = string & { readonly __brand: "CredentialId" };
export type AgentAccessStatus = "active" | "stopped" | "suspended";

export interface CredentialAgent {
  readonly id: AgentId;
  readonly status: AgentAccessStatus;
}

export interface Credential {
  readonly id: CredentialId;
  readonly agentId: AgentId;
  readonly secretDigest: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface CredentialDependencies {
  readonly nextCredentialId: () => CredentialId;
  readonly generateSecret: () => string;
  readonly digestSecret: (secret: string) => string;
  readonly now: () => Date;
}

export interface IssueCredentialInput {
  readonly agent: CredentialAgent;
  readonly credentials: readonly Credential[];
  readonly expiresAt?: Date | null;
}

export interface RotateCredentialInput {
  readonly agent: CredentialAgent;
  readonly credentials: readonly Credential[];
  readonly expiresAt?: Date | null;
}

export interface RevokeCredentialInput {
  readonly agentId: AgentId;
  readonly credentialId: CredentialId;
  readonly credentials: readonly Credential[];
}

export interface CredentialSecretResult {
  readonly credential: Credential;
  readonly secret: string;
  readonly credentials: readonly Credential[];
}

export interface CredentialRevocationResult {
  readonly credential: Credential;
  readonly changed: boolean;
  readonly credentials: readonly Credential[];
}

export class AgentAccessBlockedError extends Error {
  readonly code = "agent_access_blocked";

  constructor(readonly status: Exclude<AgentAccessStatus, "active">) {
    super(`Credential changes are blocked while the agent is ${status}.`);
    this.name = "AgentAccessBlockedError";
  }
}

export class ActiveCredentialExistsError extends Error {
  readonly code = "active_credential_exists";

  constructor(readonly agentId: AgentId) {
    super("The agent already has an active credential.");
    this.name = "ActiveCredentialExistsError";
  }
}

export class ActiveCredentialNotFoundError extends Error {
  readonly code = "active_credential_not_found";

  constructor(readonly agentId: AgentId) {
    super("The agent has no active credential to rotate.");
    this.name = "ActiveCredentialNotFoundError";
  }
}

export class MultipleActiveCredentialsError extends Error {
  readonly code = "multiple_active_credentials";

  constructor(readonly agentId: AgentId) {
    super("The agent has more than one active credential.");
    this.name = "MultipleActiveCredentialsError";
  }
}

export class CredentialNotFoundError extends Error {
  readonly code = "credential_not_found";

  constructor(readonly credentialId: CredentialId) {
    super("The credential does not belong to the agent.");
    this.name = "CredentialNotFoundError";
  }
}

export class UnsafeCredentialDigestError extends Error {
  readonly code = "unsafe_credential_digest";

  constructor() {
    super("The credential digest must differ from the raw secret.");
    this.name = "UnsafeCredentialDigestError";
  }
}

export function issueCredential(
  dependencies: CredentialDependencies,
  input: IssueCredentialInput,
): CredentialSecretResult {
  assertAgentCanReceiveCredential(input.agent);

  const issuedAt = dependencies.now();
  const activeCredential = findActiveCredential(
    input.credentials,
    input.agent.id,
    issuedAt,
  );

  if (activeCredential) {
    throw new ActiveCredentialExistsError(input.agent.id);
  }

  const { credential, secret } = createCredential(
    dependencies,
    input.agent.id,
    issuedAt,
    input.expiresAt ?? null,
  );

  return Object.freeze({
    credential,
    secret,
    credentials: Object.freeze([...input.credentials, credential]),
  });
}

export function rotateCredential(
  dependencies: CredentialDependencies,
  input: RotateCredentialInput,
): CredentialSecretResult {
  assertAgentCanReceiveCredential(input.agent);

  const rotatedAt = dependencies.now();
  const activeCredential = findActiveCredential(
    input.credentials,
    input.agent.id,
    rotatedAt,
  );

  if (!activeCredential) {
    throw new ActiveCredentialNotFoundError(input.agent.id);
  }

  const { credential, secret } = createCredential(
    dependencies,
    input.agent.id,
    rotatedAt,
    input.expiresAt ?? null,
  );
  const credentials = input.credentials.map((candidate) =>
    candidate.id === activeCredential.id
      ? freezeCredential({ ...candidate, revokedAt: rotatedAt })
      : candidate,
  );

  return Object.freeze({
    credential,
    secret,
    credentials: Object.freeze([...credentials, credential]),
  });
}

export function revokeCredential(
  dependencies: Pick<CredentialDependencies, "now">,
  input: RevokeCredentialInput,
): CredentialRevocationResult {
  const credential = input.credentials.find(
    (candidate) =>
      candidate.id === input.credentialId &&
      candidate.agentId === input.agentId,
  );

  if (!credential) {
    throw new CredentialNotFoundError(input.credentialId);
  }

  if (credential.revokedAt) {
    return Object.freeze({
      credential,
      changed: false,
      credentials: input.credentials,
    });
  }

  const revokedCredential = freezeCredential({
    ...credential,
    revokedAt: dependencies.now(),
  });

  return Object.freeze({
    credential: revokedCredential,
    changed: true,
    credentials: Object.freeze(
      input.credentials.map((candidate) =>
        candidate.id === credential.id ? revokedCredential : candidate,
      ),
    ),
  });
}

export function isCredentialActive(credential: Credential, at: Date): boolean {
  return (
    credential.revokedAt === null &&
    (credential.expiresAt === null ||
      credential.expiresAt.getTime() > at.getTime())
  );
}

function assertAgentCanReceiveCredential(agent: CredentialAgent): void {
  if (agent.status !== "active") {
    throw new AgentAccessBlockedError(agent.status);
  }
}

function findActiveCredential(
  credentials: readonly Credential[],
  agentId: AgentId,
  at: Date,
): Credential | undefined {
  const activeCredentials = credentials.filter(
    (credential) =>
      credential.agentId === agentId && isCredentialActive(credential, at),
  );

  if (activeCredentials.length > 1) {
    throw new MultipleActiveCredentialsError(agentId);
  }

  return activeCredentials[0];
}

function createCredential(
  dependencies: CredentialDependencies,
  agentId: AgentId,
  createdAt: Date,
  expiresAt: Date | null,
): { readonly credential: Credential; readonly secret: string } {
  const secret = dependencies.generateSecret();
  const secretDigest = dependencies.digestSecret(secret);

  if (!secret || !secretDigest || secretDigest === secret) {
    throw new UnsafeCredentialDigestError();
  }

  return Object.freeze({
    secret,
    credential: freezeCredential({
      id: dependencies.nextCredentialId(),
      agentId,
      secretDigest,
      createdAt,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
    }),
  });
}

function freezeCredential(credential: Credential): Credential {
  return Object.freeze(credential);
}
