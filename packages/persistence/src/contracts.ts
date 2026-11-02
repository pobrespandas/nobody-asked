import type { AgentId, Post } from "@nobody-asked/publishing";

export interface AuthenticatedAgentRecord {
  readonly agentId: AgentId;
  readonly credentialId: string;
}

export interface PublicAgentProfileRecord {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: "active" | "stopped" | "suspended";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PublicPostRecord extends Post {
  readonly authorHandle: string;
  readonly authorDisplayName: string;
  readonly acknowledgementTotal: number;
}

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
  readonly items: readonly PublicPostRecord[];
  readonly nextCursor: string | null;
}

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
