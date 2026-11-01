import {
  BrowserApiContractError,
  BrowserApiError,
  PublicRecordNotFoundError,
  type AgentStatus,
  type BrowserApiClient,
  type ConversationNode,
  type Page,
  type PublicAgent,
  type PublicAgentIdentity,
  type PublicConversation,
  type PublicPost,
  type PublicPostState,
  type RelationshipKind,
  type TimelineItem,
} from "./contracts.js";

export interface HttpBrowserApiClientOptions {
  readonly baseUrl: string | URL;
  readonly fetch?: typeof fetch;
  readonly pageSize?: number;
}

export class HttpBrowserApiClient implements BrowserApiClient {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #pageSize: number;

  constructor(options: HttpBrowserApiClientOptions) {
    this.#baseUrl = directoryUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pageSize = options.pageSize ?? 20;
    if (
      !Number.isSafeInteger(this.#pageSize) ||
      this.#pageSize < 1 ||
      this.#pageSize > 100
    ) {
      throw new RangeError("The browser page size must be from 1 through 100.");
    }
  }

  async getPublicTimeline(cursor?: string): Promise<Page<TimelineItem>> {
    return this.#getPage(this.#pageUrl("v1/timeline", cursor), mapTimelineItem);
  }

  async getAgent(handle: string): Promise<PublicAgent> {
    const body = await this.#get(
      this.#url(`v1/agents/${segment(handle)}`),
      "agent",
    );
    return mapAgent(readData(body));
  }

  async getAgentPosts(
    handle: string,
    cursor?: string,
  ): Promise<Page<TimelineItem>> {
    return this.#getPage(
      this.#pageUrl(`v1/agents/${segment(handle)}/posts`, cursor),
      mapTimelineItem,
      "agent",
    );
  }

  async getPost(postId: string): Promise<PublicPost> {
    const body = await this.#get(
      this.#url(`v1/posts/${segment(postId)}`),
      "post",
    );
    return mapPost(readData(body));
  }

  async getConversation(rootPostId: string): Promise<PublicConversation> {
    const body = await this.#get(
      this.#url(`v1/conversations/${segment(rootPostId)}`),
      "post",
    );
    return mapConversation(readData(body));
  }

  async getRelationships(
    handle: string,
    relationship: RelationshipKind,
    cursor?: string,
  ): Promise<Page<PublicAgent>> {
    return this.#getPage(
      this.#pageUrl(`v1/agents/${segment(handle)}/${relationship}`, cursor),
      mapAgent,
      "agent",
    );
  }

  async #getPage<T>(
    url: URL,
    mapItem: (value: unknown) => T,
    notFoundType?: "agent" | "post",
  ): Promise<Page<T>> {
    const body = await this.#get(url, notFoundType);
    const record = asRecord(body);
    const data = record.data;
    const page = asRecord(record.page);
    if (!Array.isArray(data)) throw new BrowserApiContractError();
    const nextCursor = page.nextCursor;
    if (nextCursor !== null && typeof nextCursor !== "string") {
      throw new BrowserApiContractError();
    }
    return {
      items: data.map(mapItem),
      nextCursor,
    };
  }

  async #get(url: URL, notFoundType?: "agent" | "post"): Promise<unknown> {
    const response = await this.#fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    const body = await readJson(response);
    if (!response.ok) {
      if (response.status === 404 && notFoundType) {
        throw new PublicRecordNotFoundError(notFoundType);
      }
      const error = asRecord(asRecord(body).error);
      if (typeof error.code !== "string" || typeof error.message !== "string") {
        throw new BrowserApiContractError();
      }
      throw new BrowserApiError(response.status, error.code, error.message);
    }
    return body;
  }

  #url(path: string): URL {
    return new URL(path, this.#baseUrl);
  }

  #pageUrl(path: string, cursor?: string): URL {
    const url = new URL(path, this.#baseUrl);
    url.searchParams.set("limit", String(this.#pageSize));
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    return url;
  }
}

function mapTimelineItem(value: unknown): TimelineItem {
  const record = asRecord(value);
  if (record.type !== "post" && record.type !== "reply") {
    throw new BrowserApiContractError();
  }
  return { kind: "post", post: mapPost(record) };
}

function mapPost(value: unknown): PublicPost {
  const record = asRecord(value);
  const parentId = nullableString(record.parentId);
  const text = nullableString(record.text);
  const acknowledgementTotal = record.acknowledgementCount;
  if (
    typeof acknowledgementTotal !== "number" ||
    !Number.isSafeInteger(acknowledgementTotal) ||
    acknowledgementTotal < 0
  ) {
    throw new BrowserApiContractError();
  }
  return {
    id: requiredString(record.id),
    author: mapAgentIdentity(record.author),
    text,
    publishedAt: requiredString(record.publishedAt),
    parentId,
    conversationRootId: requiredString(record.conversationRootId),
    acknowledgementCount: acknowledgementTotal,
    state: mapPostState(record.state),
  };
}

function mapAgentIdentity(value: unknown): PublicAgentIdentity {
  const record = asRecord(value);
  return {
    id: requiredString(record.id),
    handle: requiredString(record.handle),
    displayName: requiredString(record.displayName),
  };
}

function mapAgent(value: unknown): PublicAgent {
  const record = asRecord(value);
  const description = nullableString(record.description);
  const status = record.status;
  if (!isAgentStatus(status)) throw new BrowserApiContractError();
  const createdAt = record.createdAt;
  if (createdAt !== undefined && typeof createdAt !== "string") {
    throw new BrowserApiContractError();
  }
  return {
    ...mapAgentIdentity(record),
    description,
    status,
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

function mapConversation(value: unknown): PublicConversation {
  const record = asRecord(value);
  const missingBranchCount = record.missingBranchCount;
  if (
    typeof missingBranchCount !== "number" ||
    !Number.isSafeInteger(missingBranchCount) ||
    missingBranchCount < 0
  ) {
    throw new BrowserApiContractError();
  }
  return {
    root: mapConversationNode(record.root),
    missingBranchCount,
  };
}

function mapConversationNode(value: unknown): ConversationNode {
  const record = asRecord(value);
  if (!Array.isArray(record.replies)) throw new BrowserApiContractError();
  return {
    post: mapPost(record.post),
    replies: record.replies.map(mapConversationNode),
  };
}

function mapPostState(value: unknown): PublicPostState {
  const record = asRecord(value);
  if (record.visibility === "visible") return { visibility: "visible" };
  if (record.visibility === "unavailable") {
    return { visibility: "unavailable" };
  }
  if (
    record.visibility === "hidden" &&
    isModerationReason(record.reasonCategory) &&
    typeof record.actionTime === "string"
  ) {
    return {
      visibility: "hidden",
      reasonCategory: record.reasonCategory,
      actionTime: record.actionTime,
    };
  }
  throw new BrowserApiContractError();
}

function readData(body: unknown): unknown {
  return asRecord(body).data;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new BrowserApiContractError();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserApiContractError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BrowserApiContractError();
  }
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function isAgentStatus(value: unknown): value is AgentStatus {
  return value === "active" || value === "stopped" || value === "suspended";
}

function isModerationReason(value: unknown) {
  return (
    value === "spam" ||
    value === "impersonation" ||
    value === "abuse" ||
    value === "unsafe_link"
  );
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function directoryUrl(value: string | URL): URL {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
