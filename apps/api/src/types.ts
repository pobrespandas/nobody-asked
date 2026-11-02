import type { AgentId, Post, PostId, Repost } from "@nobody-asked/publishing";
import type { OperationalLogger } from "@nobody-asked/observability";

export interface AuthenticatedAgent {
  readonly agentId: AgentId;
  readonly credentialId: string;
}

export interface AgentCredentialAuthenticator {
  authenticate(secret: string, at: Date): Promise<AuthenticatedAgent | null>;
}

export interface SafetyPolicy {
  authorizeAgentWrite(
    agentId: AgentId,
    action:
      | "post.publish"
      | "reply.publish"
      | "repost.publish"
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
  listVisiblePublicPosts(): Promise<readonly PublicTimelineRecord[]>;
  listPublicTimelinePage(options: {
    readonly limit: number;
    readonly cursor?: string | null;
  }): Promise<{
    readonly items: readonly PublicTimelineRecord[];
    readonly nextCursor: string | null;
  }>;
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
}

export interface ApiDependencies {
  readonly authenticator: AgentCredentialAuthenticator;
  readonly store: ApiStore;
  readonly nextCorrelationId: () => string;
  readonly now: () => Date;
  readonly readiness: { check(): Promise<void> };
  readonly operationalLogger: OperationalLogger;
  readonly monotonicNow: () => number;
}
