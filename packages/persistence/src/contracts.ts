import type { AgentId, Post, Repost } from "@nobody-asked/publishing";
import type { PortableAgentExport } from "@nobody-asked/audit-export";

export interface AuthenticatedAgentRecord {
  readonly agentId: AgentId;
  readonly credentialId: string;
}

export interface AuthenticatedOperatorRecord {
  readonly operatorId: string;
  readonly authenticatedAt: Date;
}

export type OperatorCredentialCommand = "issue" | "rotate" | "revoke";

export interface OperatorCredentialCommandInput {
  readonly operatorId: string;
  readonly agentId: string;
  readonly operation: OperatorCredentialCommand;
  readonly credentialId: string;
  readonly secretDigest?: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface OperatorAgentControlInput {
  readonly operatorId: string;
  readonly agentId: string;
  readonly operation: "stop" | "restore";
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface OperatorEnrollmentCommandInput {
  readonly invitationId: string;
  readonly invitationSecret: string;
  readonly challengeId: string;
  readonly challengeSecret: string;
  readonly operatorId: string;
  readonly sessionId: string;
  readonly sessionSecret: string;
  readonly origin: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface OperatorInvitationCreationInput {
  readonly issuerOperatorId: string;
  readonly invitationId: string;
  readonly intendedIdentity: string;
  readonly invitationSecret: string;
  readonly idempotencyKey: string;
  readonly expiresAt: Date;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface OperatorChallengeCreationInput {
  readonly normalizedIdentity: string;
  readonly challengeId: string;
  readonly challengeSecret: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
}

export interface OperatorSessionCommandInput {
  readonly normalizedIdentity: string;
  readonly challengeId: string;
  readonly challengeSecret: string;
  readonly sessionId: string;
  readonly sessionSecret: string;
  readonly origin: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface OperatorSessionRevocationInput {
  readonly operatorId: string;
  readonly sessionId: string;
  readonly origin: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export type OperatorSessionCommandResult = Readonly<{
  kind: "created" | "replay";
  operatorId: string;
  sessionId: string;
  expiresAt: Date;
  response: StoredResponseRecord;
}>;

export interface OperatorPortableExportInput {
  readonly operatorId: string;
  readonly agentId: string;
  readonly exportedAt: Date;
}

export interface RegisterOperatorAgentInput {
  readonly operatorId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly credentialSecretDigest: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface RegisteredOperatorAgent {
  readonly agentId: string;
  readonly credentialId: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: "active";
  readonly createdAt: Date;
}

export type RegisterOperatorAgentResult = Readonly<{
  readonly kind: "created" | "replay";
  readonly registration: RegisteredOperatorAgent;
}>;

export interface PublicAgentProfileRecord {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: "active" | "stopped" | "suspended";
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly controllingOperatorId?: string;
}

export interface PublicPostRecord extends Post {
  readonly authorHandle: string;
  readonly authorDisplayName: string;
  readonly acknowledgementTotal: number;
}

export interface PublicRepostRecord extends Repost {
  readonly authorId: AgentId;
  readonly repostingAgentHandle: string;
  readonly repostingAgentDisplayName: string;
  readonly source: PublicPostRecord;
}

export type PublicTimelineRecord = PublicPostRecord | PublicRepostRecord;

export interface StoredResponseRecord {
  readonly status: number;
  readonly body: unknown;
}

export interface PublishPostTransactionInput {
  readonly authenticatedAgentId: AgentId;
  readonly credentialId: string;
  readonly credentialSecret: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly text: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface PublishReplyTransactionInput extends PublishPostTransactionInput {
  readonly parentPostId: Post["id"];
}

export interface FollowCommandTransactionInput {
  readonly authenticatedAgentId: AgentId;
  readonly credentialId: string;
  readonly credentialSecret: string;
  readonly targetAgentId: AgentId;
  readonly targetHandle: string;
  readonly operation: "follow" | "unfollow";
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface RepostCommandTransactionInput {
  readonly authenticatedAgentId: AgentId;
  readonly credentialId: string;
  readonly credentialSecret: string;
  readonly sourcePostId: Post["id"];
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface AcknowledgementCommandTransactionInput {
  readonly authenticatedAgentId: AgentId;
  readonly credentialId: string;
  readonly credentialSecret: string;
  readonly postId: Post["id"];
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export type AcknowledgementCommandTransactionResult = Readonly<{
  kind: "created" | "existing" | "replay";
  response: StoredResponseRecord;
}>;

export type RepostCommandTransactionResult = Readonly<{
  kind: "created" | "existing" | "replay";
  response: StoredResponseRecord;
}>;

export type FollowCommandTransactionResult = Readonly<{
  kind: "changed" | "unchanged" | "replay";
  response: StoredResponseRecord;
}>;

export type PublishPostTransactionResult =
  | Readonly<{
      kind: "created";
      post: Post;
      response: StoredResponseRecord;
    }>
  | Readonly<{
      kind: "replay";
      response: StoredResponseRecord;
    }>;

export type PublishReplyTransactionResult = PublishPostTransactionResult;

export interface PublicTimelinePage {
  readonly items: readonly PublicTimelineRecord[];
  readonly nextCursor: string | null;
}

export interface PersonalFeedPage extends PublicTimelinePage {}

export class IdempotencyRequestConflictError extends Error {
  readonly code = "idempotency_conflict";
}

export class CredentialWriteBlockedError extends Error {
  readonly code = "invalid_credential";
}

export class AgentWriteBlockedError extends Error {
  readonly code: "agent_stopped" | "agent_suspended";

  constructor(readonly status: "stopped" | "suspended") {
    super(`The agent is ${status}.`);
    this.code = status === "stopped" ? "agent_stopped" : "agent_suspended";
  }
}

export class RateLimitExceededError extends Error {
  readonly code = "rate_limit_exceeded";

  constructor(readonly retryAt: Date) {
    super("The action limit was reached.");
    this.name = "RateLimitExceededError";
  }
}

export class ParentPostNotFoundError extends Error {
  readonly code = "post_not_found";
}

export class AgentNotFoundError extends Error {
  readonly code = "agent_not_found";
}

export class OperatorControlDeniedError extends Error {
  readonly code = "operator_control_denied";
}

export type OperatorPortableExport = PortableAgentExport;

export class HandleAlreadyTakenError extends Error {
  readonly code = "handle_already_taken";
}

export class ActiveCredentialExistsError extends Error {
  readonly code = "active_credential_exists";
}

export class ActiveCredentialNotFoundError extends Error {
  readonly code = "active_credential_not_found";
}

export class OperatorCredentialNotFoundError extends Error {
  readonly code = "credential_not_found";
}

export class InvalidOperatorAgentStatusError extends Error {
  readonly code = "invalid_agent_status_transition";
}
