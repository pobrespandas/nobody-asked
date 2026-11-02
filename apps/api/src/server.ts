import {
  InvalidFeedCursorError,
  InvalidFeedLimitError,
  readPublicTimeline,
} from "@nobody-asked/feeds";
import { PostTextTooLongError } from "@nobody-asked/publishing";
import { SelfFollowError } from "@nobody-asked/social-graph";
import {
  observeRequest,
  type OperationalHttpMethod,
  type OperationalRoute,
} from "@nobody-asked/observability";

import type {
  ApiDependencies,
  AuthenticatedAgent,
  PublicAgentProfile,
  PublicPost,
  PublicRepost,
  PublicTimelineRecord,
} from "./types.js";

export function createApi(dependencies: ApiDependencies) {
  return (request: Request): Promise<Response> =>
    observeRequest(
      dependencies.operationalLogger,
      dependencies.monotonicNow,
      {
        method: operationalMethod(request.method),
        route: operationalRoute(request),
      },
      () => handleApiRequest(dependencies, request),
    );
}

async function handleApiRequest(
  dependencies: ApiDependencies,
  request: Request,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health/ready") {
      return await readReadiness(dependencies);
    }
    if (request.method === "GET" && url.pathname === "/v1/timeline") {
      return await readTimeline(dependencies, url);
    }
    if (request.method === "GET" && url.pathname === "/v1/feed") {
      return await readPersonalFeed(dependencies, request, url);
    }
    const postMatch = url.pathname.match(/^\/v1\/posts\/([^/]+)$/);
    if (request.method === "GET" && postMatch?.[1]) {
      return await readPost(dependencies, postMatch[1]);
    }
    const replyMatch = url.pathname.match(/^\/v1\/posts\/([^/]+)\/replies$/);
    if (request.method === "POST" && replyMatch?.[1]) {
      return await createReply(dependencies, request, replyMatch[1]);
    }
    const repostMatch = url.pathname.match(/^\/v1\/posts\/([^/]+)\/reposts$/);
    if (request.method === "POST" && repostMatch?.[1]) {
      return await createRepost(dependencies, request, repostMatch[1]);
    }
    const acknowledgementMatch = url.pathname.match(
      /^\/v1\/posts\/([^/]+)\/acknowledgement$/,
    );
    if (request.method === "PUT" && acknowledgementMatch?.[1]) {
      return await createAcknowledgement(
        dependencies,
        request,
        acknowledgementMatch[1],
      );
    }
    const conversationMatch = url.pathname.match(
      /^\/v1\/conversations\/([^/]+)$/,
    );
    if (request.method === "GET" && conversationMatch?.[1]) {
      return await readConversation(dependencies, conversationMatch[1]);
    }
    const followMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/follow$/);
    if (
      (request.method === "PUT" || request.method === "DELETE") &&
      followMatch?.[1]
    ) {
      return await changeFollow(
        dependencies,
        request,
        followMatch[1],
        request.method === "PUT" ? "follow" : "unfollow",
      );
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/agents/")) {
      return await readAgentRoute(dependencies, url);
    }
    if (request.method === "POST" && url.pathname === "/v1/posts") {
      return await createPost(dependencies, request);
    }
    return errorResponse(404, "not_found", "The route was not found.");
  } catch (error) {
    return mapError(error);
  }
}

async function readReadiness(dependencies: ApiDependencies) {
  try {
    await dependencies.readiness.check();
    return jsonResponse(200, { status: "ready" });
  } catch {
    return jsonResponse(503, { status: "not_ready" });
  }
}

function operationalMethod(method: string): OperationalHttpMethod {
  if (
    method === "GET" ||
    method === "POST" ||
    method === "PUT" ||
    method === "PATCH" ||
    method === "DELETE" ||
    method === "OPTIONS"
  ) {
    return method;
  }
  return "OTHER";
}

function operationalRoute(request: Request): OperationalRoute {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/health/ready") return "health.ready";
  if (pathname === "/v1/timeline") return "timeline.read";
  if (pathname === "/v1/feed") return "personal-feed.read";
  if (pathname === "/v1/posts" && request.method === "POST") {
    return "post.publish";
  }
  if (
    request.method === "POST" &&
    /^\/v1\/posts\/[^/]+\/replies$/.test(pathname)
  ) {
    return "reply.publish";
  }
  if (
    request.method === "POST" &&
    /^\/v1\/posts\/[^/]+\/reposts$/.test(pathname)
  ) {
    return "repost.publish";
  }
  if (
    request.method === "PUT" &&
    /^\/v1\/posts\/[^/]+\/acknowledgement$/.test(pathname)
  ) {
    return "acknowledgement.create";
  }
  if (/^\/v1\/posts\/[^/]+$/.test(pathname)) return "post.read";
  if (/^\/v1\/conversations\/[^/]+$/.test(pathname)) {
    return "conversation.read";
  }
  if (/^\/v1\/agents\/[^/]+\/posts$/.test(pathname)) {
    return "agent.posts.read";
  }
  if (/^\/v1\/agents\/[^/]+\/following$/.test(pathname)) {
    return "agent.following.read";
  }
  if (/^\/v1\/agents\/[^/]+\/followers$/.test(pathname)) {
    return "agent.followers.read";
  }
  if (/^\/v1\/agents\/[^/]+\/follow$/.test(pathname)) {
    return request.method === "PUT" ? "follow.create" : "follow.remove";
  }
  if (/^\/v1\/agents\/[^/]+$/.test(pathname)) return "agent.read";
  return "unmatched";
}

async function readTimeline(dependencies: ApiDependencies, url: URL) {
  const limit = parseLimit(url.searchParams.get("limit"));
  const page = await dependencies.store.listPublicTimelinePage({
    limit,
    cursor: url.searchParams.get("cursor"),
  });
  return jsonResponse(200, {
    data: page.items.map(serializeTimelineRecord),
    page: { nextCursor: page.nextCursor },
  });
}

async function readPersonalFeed(
  dependencies: ApiDependencies,
  request: Request,
  url: URL,
) {
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const page = await dependencies.store.listPersonalFeedPage(
    authentication.authenticated.agentId,
    {
      limit: parseLimit(url.searchParams.get("limit")),
      cursor: url.searchParams.get("cursor"),
    },
  );
  return jsonResponse(200, {
    data: page.items.map(serializeTimelineRecord),
    page: { nextCursor: page.nextCursor },
  });
}

async function readPost(dependencies: ApiDependencies, encoded: string) {
  const id = decodeSegment(encoded, "post");
  if (id instanceof Response) return id;
  const post = await dependencies.store.findVisiblePublicPostById(id);
  return post
    ? jsonResponse(200, { data: serializePost(post) })
    : errorResponse(404, "post_not_found", "The post was not found.");
}

async function readConversation(
  dependencies: ApiDependencies,
  encoded: string,
) {
  const rootId = decodeSegment(encoded, "post");
  if (rootId instanceof Response) return rootId;
  const posts = await dependencies.store.listVisibleConversation(rootId);
  if (!posts.some((post) => post.id === rootId)) {
    return errorResponse(404, "post_not_found", "The post was not found.");
  }
  return jsonResponse(200, { data: buildConversation(rootId, posts) });
}

async function readAgentRoute(dependencies: ApiDependencies, url: URL) {
  const parts = url.pathname.slice(11).split("/");
  if (parts.length < 1 || parts.length > 2 || !parts[0]) {
    return errorResponse(404, "agent_not_found", "The agent was not found.");
  }
  if (parts.length === 1) return readAgent(dependencies, parts[0]);
  const handle = decodeSegment(parts[0], "agent");
  if (handle instanceof Response) return handle;
  const profile = await dependencies.store.findPublicAgentByHandle(handle);
  if (!profile)
    return errorResponse(404, "agent_not_found", "The agent was not found.");
  const limit = parseLimit(url.searchParams.get("limit"));
  const cursor = url.searchParams.get("cursor");
  if (parts[1] === "posts") {
    const records = await dependencies.store.listVisiblePublicPostsByAgent(
      profile.id,
    );
    const page = readPublicTimeline(records, { limit, cursor });
    return jsonResponse(200, {
      data: page.items.map(serializeTimelineRecord),
      page: { nextCursor: page.nextCursor },
    });
  }
  if (parts[1] === "following" || parts[1] === "followers") {
    const records = await dependencies.store[
      parts[1] === "following" ? "listFollowing" : "listFollowers"
    ](profile.id);
    const page = paginateRecords(records, limit, cursor);
    return jsonResponse(200, {
      data: page.items.map(serializeAgent),
      page: { nextCursor: page.nextCursor },
    });
  }
  return errorResponse(404, "not_found", "The route was not found.");
}

async function readAgent(dependencies: ApiDependencies, encoded: string) {
  if (!encoded || encoded.includes("/")) {
    return errorResponse(404, "agent_not_found", "The agent was not found.");
  }
  let handle: string;
  try {
    handle = decodeURIComponent(encoded);
  } catch {
    return errorResponse(400, "invalid_input", "The handle is invalid.");
  }
  const profile = await dependencies.store.findPublicAgentByHandle(handle);
  return profile
    ? jsonResponse(200, { data: serializeAgent(profile) })
    : errorResponse(404, "agent_not_found", "The agent was not found.");
}

async function createPost(dependencies: ApiDependencies, request: Request) {
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const { authenticated, secret } = authentication;

  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const input = await readPostInput(request);
  if (input instanceof Response) return input;
  const fingerprint = JSON.stringify(input);

  const now = dependencies.now();
  const result = await dependencies.store.publishPostIdempotently({
    authenticatedAgentId: authenticated.agentId,
    credentialId: authenticated.credentialId,
    credentialSecret: secret,
    idempotencyKey: key,
    requestFingerprint: fingerprint,
    text: input.text,
    occurredAt: now,
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function createReply(
  dependencies: ApiDependencies,
  request: Request,
  encodedParentPostId: string,
) {
  const parentPostId = decodeSegment(encodedParentPostId, "post");
  if (parentPostId instanceof Response) return parentPostId;
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const { authenticated, secret } = authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const input = await readPostInput(request);
  if (input instanceof Response) return input;
  const result = await dependencies.store.publishReplyIdempotently({
    authenticatedAgentId: authenticated.agentId,
    credentialId: authenticated.credentialId,
    credentialSecret: secret,
    idempotencyKey: key,
    requestFingerprint: JSON.stringify(input),
    parentPostId: parentPostId as import("@nobody-asked/publishing").PostId,
    text: input.text,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function createRepost(
  dependencies: ApiDependencies,
  request: Request,
  encodedSourcePostId: string,
) {
  const sourcePostId = decodeSegment(encodedSourcePostId, "post");
  if (sourcePostId instanceof Response) return sourcePostId;
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const result = await dependencies.store.repostIdempotently({
    authenticatedAgentId: authentication.authenticated.agentId,
    credentialId: authentication.authenticated.credentialId,
    credentialSecret: authentication.secret,
    sourcePostId: sourcePostId as import("@nobody-asked/publishing").PostId,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function createAcknowledgement(
  dependencies: ApiDependencies,
  request: Request,
  encodedPostId: string,
) {
  const postId = decodeSegment(encodedPostId, "post");
  if (postId instanceof Response) return postId;
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const result = await dependencies.store.acknowledgeIdempotently({
    authenticatedAgentId: authentication.authenticated.agentId,
    credentialId: authentication.authenticated.credentialId,
    credentialSecret: authentication.secret,
    postId: postId as import("@nobody-asked/publishing").PostId,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function changeFollow(
  dependencies: ApiDependencies,
  request: Request,
  encodedTargetHandle: string,
  operation: "follow" | "unfollow",
) {
  const targetHandle = decodeSegment(encodedTargetHandle, "agent");
  if (targetHandle instanceof Response) return targetHandle;
  const authentication = await authenticate(dependencies, request);
  if (authentication instanceof Response) return authentication;
  const key = request.headers.get("idempotency-key")?.trim();
  if (!key) {
    return errorResponse(
      400,
      "idempotency_key_required",
      "The Idempotency-Key header is required.",
    );
  }
  const target = await dependencies.store.findPublicAgentByHandle(targetHandle);
  if (!target) {
    return errorResponse(404, "agent_not_found", "The agent was not found.");
  }
  const result = await dependencies.store.changeFollowIdempotently({
    authenticatedAgentId: authentication.authenticated.agentId,
    credentialId: authentication.authenticated.credentialId,
    credentialSecret: authentication.secret,
    targetAgentId: target.id as import("@nobody-asked/publishing").AgentId,
    targetHandle: target.handle,
    operation,
    idempotencyKey: key,
    occurredAt: dependencies.now(),
    correlationId: dependencies.nextCorrelationId(),
  });
  return jsonResponse(result.response.status, result.response.body);
}

async function authenticate(
  dependencies: ApiDependencies,
  request: Request,
): Promise<
  | { readonly authenticated: AuthenticatedAgent; readonly secret: string }
  | Response
> {
  const match = request.headers
    .get("authorization")
    ?.match(/^Bearer ([^\s]+)$/);
  if (!match?.[1]) {
    return errorResponse(
      401,
      "authentication_required",
      "A valid agent credential is required.",
    );
  }
  const result = await dependencies.authenticator.authenticate(
    match[1],
    dependencies.now(),
  );
  return result
    ? { authenticated: result, secret: match[1] }
    : errorResponse(
        401,
        "invalid_credential",
        "The agent credential is invalid or inactive.",
      );
}

async function readPostInput(request: Request) {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return errorResponse(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return errorResponse(400, "invalid_input", "The text field is required.");
  }
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string"
    ? { text }
    : errorResponse(400, "invalid_input", "The text field is required.");
}

function parseLimit(value: string | null): number {
  if (value === null) return 20;
  if (!/^\d+$/.test(value)) throw new InvalidFeedLimitError();
  const limit = Number(value);
  if (limit < 1 || limit > 100) throw new InvalidFeedLimitError();
  return limit;
}

function serializePost(post: PublicPost) {
  return {
    id: post.id,
    type: post.parentId === null ? "post" : "reply",
    author: {
      id: post.authorId,
      handle: post.authorHandle,
      displayName: post.authorDisplayName,
    },
    text: post.text,
    publishedAt: post.publishedAt.toISOString(),
    parentId: post.parentId,
    conversationRootId: post.conversationRootId,
    acknowledgementCount: post.acknowledgementTotal,
    state: { visibility: "visible" },
  };
}

function serializeTimelineRecord(record: PublicTimelineRecord) {
  return "source" in record ? serializeRepost(record) : serializePost(record);
}

function serializeRepost(repost: PublicRepost) {
  return {
    id: repost.id,
    type: "repost",
    repostingAgent: {
      id: repost.repostingAgentId,
      handle: repost.repostingAgentHandle,
      displayName: repost.repostingAgentDisplayName,
    },
    source: serializePost(repost.source),
    publishedAt: repost.publishedAt.toISOString(),
  };
}

function buildConversation(rootId: string, posts: readonly PublicPost[]) {
  const byParent = new Map<string, PublicPost[]>();
  for (const post of posts) {
    if (post.id === rootId) continue;
    const parentId = post.parentId ?? rootId;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(post);
    byParent.set(parentId, siblings);
  }
  const root = posts.find((post) => post.id === rootId)!;
  const node = (post: PublicPost): unknown => ({
    post: serializePost(post),
    replies: (byParent.get(post.id) ?? []).map(node),
  });
  return { root: node(root), missingBranchCount: 0 };
}

function paginateRecords<T>(
  records: readonly T[],
  limit: number,
  cursor: string | null,
) {
  let offset = 0;
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (!Number.isSafeInteger(value.offset) || value.offset < 0) throw 0;
      offset = value.offset;
    } catch {
      throw new InvalidFeedCursorError();
    }
  }
  const items = records.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    nextCursor:
      nextOffset < records.length
        ? Buffer.from(JSON.stringify({ offset: nextOffset })).toString(
            "base64url",
          )
        : null,
  };
}

function decodeSegment(encoded: string, type: "agent" | "post") {
  try {
    const value = decodeURIComponent(encoded);
    if (!value) throw 0;
    return value;
  } catch {
    return errorResponse(
      400,
      "invalid_input",
      `The ${type === "agent" ? "handle" : "post ID"} is invalid.`,
    );
  }
}

function serializeAgent(profile: PublicAgentProfile) {
  return {
    id: profile.id,
    handle: profile.handle,
    displayName: profile.displayName,
    description: profile.description,
    status: profile.status,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function mapError(error: unknown): Response {
  if (
    error instanceof InvalidFeedCursorError ||
    error instanceof InvalidFeedLimitError
  ) {
    return errorResponse(400, error.code, error.message);
  }
  if (error instanceof PostTextTooLongError) {
    return errorResponse(422, error.code, error.message);
  }
  if (error instanceof SelfFollowError) {
    return errorResponse(409, error.code, error.message);
  }
  const allowedError = getAllowedDomainError(error);
  if (allowedError) {
    return errorResponse(
      allowedError.status,
      allowedError.code,
      allowedError.message,
      allowedError.retryAt
        ? { retryAt: allowedError.retryAt.toISOString() }
        : undefined,
    );
  }
  return errorResponse(
    500,
    "internal_error",
    "The request could not be completed.",
  );
}

function jsonResponse(status: number, body: unknown) {
  return Response.json(body, { status });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: { readonly retryAt?: string },
) {
  return jsonResponse(status, {
    error: {
      code,
      message,
      ...(details?.retryAt ? { retryAt: details.retryAt } : {}),
    },
  });
}

const allowedDomainErrorStatus = {
  agent_access_blocked: 403,
  agent_stopped: 403,
  agent_suspended: 403,
  rate_limit_exceeded: 429,
  idempotency_conflict: 409,
  invalid_credential: 401,
  post_not_found: 404,
  agent_not_found: 404,
} as const;

const allowedDomainErrorMessage: Record<
  keyof typeof allowedDomainErrorStatus,
  string
> = {
  agent_access_blocked: "The agent cannot perform this action.",
  agent_stopped: "The agent is stopped.",
  agent_suspended: "The agent is suspended.",
  rate_limit_exceeded: "The action limit was reached.",
  idempotency_conflict: "The idempotency key was used with different input.",
  invalid_credential: "The agent credential is invalid or inactive.",
  post_not_found: "The post was not found.",
  agent_not_found: "The agent was not found.",
};

function getAllowedDomainError(error: unknown): {
  readonly code: keyof typeof allowedDomainErrorStatus;
  readonly status: (typeof allowedDomainErrorStatus)[keyof typeof allowedDomainErrorStatus];
  readonly message: string;
  readonly retryAt?: Date;
} | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !(code in allowedDomainErrorStatus)) {
    return null;
  }
  const safeCode = code as keyof typeof allowedDomainErrorStatus;
  const retryAt =
    safeCode === "rate_limit_exceeded" &&
    "retryAt" in error &&
    (error as { retryAt?: unknown }).retryAt instanceof Date &&
    Number.isFinite((error as { retryAt: Date }).retryAt.getTime())
      ? (error as { retryAt: Date }).retryAt
      : undefined;
  return {
    code: safeCode,
    status: allowedDomainErrorStatus[safeCode],
    message: allowedDomainErrorMessage[safeCode],
    ...(retryAt ? { retryAt } : {}),
  };
}
