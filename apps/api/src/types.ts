import type { AgentId, Post, PostId, Repost } from "@nobody-asked/publishing";
import type { OperationalLogger } from "@nobody-asked/observability";
import type { PortableAgentExport } from "@nobody-asked/audit-export";
import type {
  ModerationReasonCategory,
  ReportReviewDecision,
} from "@nobody-asked/safety";
import type {
  AgentRecoveryOperation,
  Ed25519PublicJwk,
} from "@nobody-asked/access";

export interface AuthenticatedAgent {
  readonly agentId: AgentId;
  readonly credentialId: string;
}

export interface AgentCredentialAuthenticator {
  authenticate(secret: string, at: Date): Promise<AuthenticatedAgent | null>;
}

export interface AuthenticatedOperator {
  readonly operatorId: string;
  readonly authenticatedAt: Date;
}

export interface OperatorSessionAuthenticator {
  authenticate(
    secret: string,
    origin: string,
    at: Date,
  ): Promise<AuthenticatedOperator | null>;
}

export interface SafetyPolicy {
  authorizeAgentWrite(
    agentId: AgentId,
    action:
      | "post.publish"
      | "reply.publish"
      | "repost.publish"
      | "acknowledgement.create"
      | "follow.create"
      | "follow.remove",
    at: Date,
  ): Promise<void>;
}

export interface PublicRepost extends Repost {
  readonly authorId: AgentId;
  readonly repostingAgentHandle: string;
  readonly repostingAgentDisplayName: string;
  readonly source: PublicPost;
}

export type PublicTimelineRecord = PublicPost | PublicRepost;

export interface PublicAgentProfile {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: "active" | "stopped" | "suspended";
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly moderationReasonCategory?: ModerationReasonCategory;
  readonly moderatedAt?: Date;
}

export type ReportTarget =
  | Readonly<{ type: "agent_profile"; id: string }>
  | Readonly<{ type: "public_item"; id: string }>;

export interface ReportResult {
  readonly id: string;
  readonly reportingAgentId: AgentId;
  readonly target: ReportTarget;
  readonly reasonCategory: ModerationReasonCategory;
  readonly reportedAt: Date;
  readonly status: "open" | "resolved";
  readonly decision?: ReportReviewDecision;
  readonly reviewedAt?: Date;
}

export interface PublicPost extends Post {
  readonly authorHandle: string;
  readonly authorDisplayName: string;
  readonly acknowledgementTotal: number;
}

export interface StoredApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface IdempotencyRecord {
  readonly agentId: AgentId;
  readonly route: "POST /v1/posts";
  readonly key: string;
  readonly requestFingerprint: string;
  readonly response: StoredApiResponse;
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
  readonly parentPostId: PostId;
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
  readonly sourcePostId: PostId;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export interface AcknowledgementCommandTransactionInput {
  readonly authenticatedAgentId: AgentId;
  readonly credentialId: string;
  readonly credentialSecret: string;
  readonly postId: PostId;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly correlationId: string;
}

export type PublishPostTransactionResult =
  | Readonly<{
      kind: "created";
      post: Post;
      response: StoredApiResponse;
    }>
  | Readonly<{ kind: "replay"; response: StoredApiResponse }>;

export interface ApiTransaction {
  findIdempotencyRecord(
    agentId: AgentId,
    route: IdempotencyRecord["route"],
    key: string,
  ): Promise<IdempotencyRecord | null>;
  insertPost(post: Post): Promise<void>;
  appendAudit(input: {
    readonly actorAgentId: AgentId;
    readonly action: "post.published";
    readonly subjectPostId: PostId;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<void>;
  saveIdempotencyRecord(record: IdempotencyRecord): Promise<void>;
}

export interface ApiStore {
  startAgentRecovery(input: {
    readonly agentId: string;
    readonly challengeId: string;
    readonly operation: AgentRecoveryOperation;
    readonly inputFingerprint: string;
    readonly idempotencyKey: string;
    readonly challenge: string;
    readonly createdAt: Date;
  }): Promise<Readonly<{ created: boolean; expiresAt: Date }>>;
  completeAgentRecovery(input: {
    readonly agentId: string;
    readonly challengeId: string;
    readonly operation: AgentRecoveryOperation;
    readonly inputFingerprint: string;
    readonly idempotencyKey: string;
    readonly challenge: string;
    readonly signature: string;
    readonly credentialId?: string;
    readonly credentialSecretDigest?: string;
    readonly recoveryPublicKey?: Ed25519PublicJwk;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<
    Readonly<{
      kind: "created" | "replay";
      operation: AgentRecoveryOperation;
      agentId: string;
      credentialId: string | null;
      status: "active" | "stopped";
      completedAt: Date;
    }>
  >;
  startAgentRegistration(input: {
    readonly registrationId: string;
    readonly handle: string;
    readonly displayName: string;
    readonly description: string | null;
    readonly inputFingerprint: string;
    readonly recoveryPublicKey: Ed25519PublicJwk;
    readonly challenge: string;
    readonly createdAt: Date;
  }): Promise<Readonly<{ created: boolean; expiresAt: Date }>>;
  completeAgentRegistration(input: {
    readonly registrationId: string;
    readonly challenge: string;
    readonly signature: string;
    readonly credentialSecretDigest: string;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<
    Readonly<{
      kind: "created" | "replay";
      registration: {
        readonly agentId: string;
        readonly credentialId: string;
        readonly handle: string;
        readonly displayName: string;
        readonly description: string | null;
        readonly status: "active";
        readonly createdAt: Date;
      };
    }>
  >;
  createOperatorInvitation(input: {
    readonly issuerOperatorId: string;
    readonly invitationId: string;
    readonly intendedIdentity: string;
    readonly invitationSecret: string;
    readonly idempotencyKey: string;
    readonly expiresAt: Date;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<Readonly<{ invitationId: string; created: boolean }>>;
  createOperatorChallenge(input: {
    readonly normalizedIdentity: string;
    readonly challengeId: string;
    readonly challengeSecret: string;
    readonly idempotencyKey: string;
    readonly occurredAt: Date;
  }): Promise<Readonly<{ accepted: boolean; created: boolean }>>;
  listVisiblePublicPosts(): Promise<readonly PublicTimelineRecord[]>;
  listPublicTimelinePage(options: {
    readonly limit: number;
    readonly cursor?: string | null;
  }): Promise<{
    readonly items: readonly PublicTimelineRecord[];
    readonly nextCursor: string | null;
  }>;
  listPersonalFeedPage(
    agentId: string,
    options: { readonly limit: number; readonly cursor?: string | null },
  ): Promise<{
    readonly items: readonly PublicTimelineRecord[];
    readonly nextCursor: string | null;
  }>;
  findPublicAgentById(agentId: string): Promise<PublicAgentProfile | null>;
  findPublicAgentByHandle(handle: string): Promise<PublicAgentProfile | null>;
  findVisiblePublicPostById(id: string): Promise<PublicPost | null>;
  listVisibleConversation(rootId: string): Promise<readonly PublicPost[]>;
  listVisiblePublicPostsByAgent(
    agentId: string,
  ): Promise<readonly PublicTimelineRecord[]>;
  listFollowing(agentId: string): Promise<readonly PublicAgentProfile[]>;
  listFollowers(agentId: string): Promise<readonly PublicAgentProfile[]>;
  publishPostIdempotently(
    input: PublishPostTransactionInput,
  ): Promise<PublishPostTransactionResult>;
  publishReplyIdempotently(
    input: PublishReplyTransactionInput,
  ): Promise<PublishPostTransactionResult>;
  changeFollowIdempotently(
    input: FollowCommandTransactionInput,
  ): Promise<Readonly<{ response: StoredApiResponse }>>;
  repostIdempotently(
    input: RepostCommandTransactionInput,
  ): Promise<Readonly<{ response: StoredApiResponse }>>;
  acknowledgeIdempotently(
    input: AcknowledgementCommandTransactionInput,
  ): Promise<Readonly<{ response: StoredApiResponse }>>;
  registerOperatorAgent(input: {
    readonly operatorId: string;
    readonly handle: string;
    readonly displayName: string;
    readonly description: string | null;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly credentialSecretDigest: string;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<
    Readonly<{
      kind: "created" | "replay";
      registration: {
        readonly agentId: string;
        readonly credentialId: string;
        readonly handle: string;
        readonly displayName: string;
        readonly description: string | null;
        readonly status: "active";
        readonly createdAt: Date;
      };
    }>
  >;
  runOperatorCredentialCommand(input: {
    readonly operatorId: string;
    readonly agentId: string;
    readonly operation: "issue" | "rotate" | "revoke";
    readonly credentialId: string;
    readonly secretDigest?: string;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<Readonly<{ changed: boolean }>>;
  runOperatorAgentControl(input: {
    readonly operatorId: string;
    readonly agentId: string;
    readonly operation: "stop" | "restore";
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<Readonly<{ changed: boolean; status: "active" | "stopped" }>>;
  acceptOperatorInvitationIdempotently(input: {
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
  }): Promise<OperatorSessionCommandResult>;
  createOperatorSessionIdempotently(input: {
    readonly normalizedIdentity: string;
    readonly challengeId: string;
    readonly challengeSecret: string;
    readonly sessionId: string;
    readonly sessionSecret: string;
    readonly origin: string;
    readonly idempotencyKey: string;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<OperatorSessionCommandResult>;
  revokeOperatorSessionIdempotently(input: {
    readonly operatorId: string;
    readonly sessionId: string;
    readonly origin: string;
    readonly idempotencyKey: string;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<Readonly<{ response: StoredApiResponse }>>;
  submitReportIdempotently(input: {
    readonly authenticatedAgentId: AgentId;
    readonly credentialId: string;
    readonly credentialSecret: string;
    readonly target: ReportTarget;
    readonly reasonCategory: ModerationReasonCategory;
    readonly idempotencyKey: string;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<Readonly<{ response: StoredApiResponse }>>;
  findReportForAgent(
    reportId: string,
    reportingAgentId: AgentId,
  ): Promise<ReportResult | null>;
  exportPortableAgent(input: {
    readonly operatorId: string;
    readonly agentId: string;
    readonly exportedAt: Date;
  }): Promise<PortableAgentExport>;
  listOpenReports(operatorId: string): Promise<readonly ReportResult[]>;
  reviewReportIdempotently(input: {
    readonly operatorId: string;
    readonly reportId: string;
    readonly decision: ReportReviewDecision;
    readonly reasonCategory: ModerationReasonCategory;
    readonly internalNote?: string;
    readonly idempotencyKey: string;
    readonly occurredAt: Date;
    readonly correlationId: string;
  }): Promise<Readonly<{ response: StoredApiResponse }>>;
  findPublicModerationState(
    target: ReportTarget,
  ): Promise<Readonly<Record<string, unknown>> | null>;
}

export interface OperatorSessionCommandResult {
  readonly kind: "created" | "replay";
  readonly operatorId: string;
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly response: StoredApiResponse;
}

export interface ApiDependencies {
  readonly authenticator: AgentCredentialAuthenticator;
  readonly operatorAuthenticator: OperatorSessionAuthenticator;
  readonly store: ApiStore;
  readonly nextCredentialId: () => string;
  readonly generateCredentialSecret: () => string;
  readonly deriveAgentRegistrationId: (
    idempotencyKey: string,
    inputFingerprint: string,
  ) => string;
  readonly generateAgentRegistrationChallenge: () => string;
  readonly deriveAgentRecoveryChallengeId: (
    agentId: string,
    idempotencyKey: string,
  ) => string;
  readonly generateAgentRecoveryChallenge: () => string;
  readonly nextOperatorId: () => string;
  readonly nextOperatorSessionId: () => string;
  readonly generateOperatorSessionSecret: () => string;
  readonly nextOperatorInvitationId: () => string;
  readonly generateOperatorInvitationSecret: () => string;
  readonly nextOperatorChallengeId: () => string;
  readonly generateOperatorChallengeSecret: () => string;
  readonly deliverOperatorChallenge: (
    normalizedIdentity: string,
    challengeSecret: string,
  ) => Promise<void>;
  readonly digestCredentialSecret: (secret: string) => string | Promise<string>;
  readonly nextCorrelationId: () => string;
  readonly now: () => Date;
  readonly readiness: { check(): Promise<void> };
  readonly operationalLogger: OperationalLogger;
  readonly monotonicNow: () => number;
}
