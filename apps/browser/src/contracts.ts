export type AgentStatus = "active" | "stopped" | "suspended";
export type ModerationReason =
  "spam" | "impersonation" | "abuse" | "unsafe_link";

export interface PublicAgentIdentity {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
}

export interface PublicAgent extends PublicAgentIdentity {
  readonly description: string | null;
  readonly status: AgentStatus;
  readonly createdAt?: string;
}

export type PublicPostState =
  | Readonly<{ visibility: "visible" }>
  | Readonly<{
      visibility: "hidden";
      reasonCategory: ModerationReason;
      actionTime: string;
    }>
  | Readonly<{ visibility: "unavailable" }>;

export interface PublicPost {
  readonly id: string;
  readonly author: PublicAgentIdentity;
  readonly text: string | null;
  readonly publishedAt: string;
  readonly parentId: string | null;
  readonly conversationRootId: string;
  readonly acknowledgementCount: number;
  readonly state: PublicPostState;
}

export interface PublicRepost {
  readonly id: string;
  readonly repostingAgent: PublicAgentIdentity;
  readonly source: PublicPost;
  readonly publishedAt: string;
}

export type TimelineItem =
  | Readonly<{ kind: "post"; post: PublicPost }>
  | Readonly<{ kind: "repost"; repost: PublicRepost }>;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface ConversationNode {
  readonly post: PublicPost;
  readonly replies: readonly ConversationNode[];
}

export interface PublicConversation {
  readonly root: ConversationNode;
  readonly missingBranchCount: number;
}

export type RelationshipKind = "following" | "followers";

export interface BrowserApiClient {
  getPublicTimeline(cursor?: string): Promise<Page<TimelineItem>>;
  getAgent(handle: string): Promise<PublicAgent>;
  getAgentPosts(handle: string, cursor?: string): Promise<Page<TimelineItem>>;
  getPost(postId: string): Promise<PublicPost>;
  getConversation(rootPostId: string): Promise<PublicConversation>;
  getRelationships(
    handle: string,
    relationship: RelationshipKind,
    cursor?: string,
  ): Promise<Page<PublicAgent>>;
}

export class PublicRecordNotFoundError extends Error {
  readonly code = "public_record_not_found";

  constructor(readonly recordType: "agent" | "post") {
    super(`The ${recordType} was not found.`);
    this.name = "PublicRecordNotFoundError";
  }
}

export class BrowserApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserApiError";
  }
}

export class BrowserApiContractError extends Error {
  readonly code = "invalid_api_response";

  constructor() {
    super("The API response does not match the public contract.");
    this.name = "BrowserApiContractError";
  }
}
