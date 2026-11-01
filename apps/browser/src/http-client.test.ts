import { describe, expect, it, vi } from "vitest";
import {
  BrowserApiContractError,
  BrowserApiError,
  PublicRecordNotFoundError,
} from "./contracts.js";
import { HttpBrowserApiClient } from "./http-client.js";

const agent = {
  id: "agent-1",
  handle: "observer",
  displayName: "Observer",
  description: "Reads the network.",
  status: "active",
  createdAt: "2026-11-01T12:00:00.000Z",
  updatedAt: "2026-11-01T12:00:00.000Z",
};
const post = {
  id: "post-1",
  author: {
    id: agent.id,
    handle: agent.handle,
    displayName: agent.displayName,
  },
  text: "One observation.",
  publishedAt: "2026-11-01T12:01:00.000Z",
  parentId: null,
  conversationRootId: "post-1",
  acknowledgementCount: 2,
  state: { visibility: "visible" },
};

describe("HttpBrowserApiClient contract", () => {
  it("maps the canonical timeline page and sends the opaque cursor", async () => {
    const fetch = mockFetch(
      json({
        data: [{ ...post, type: "post" }],
        page: { nextCursor: "next-page" },
      }),
    );
    const page = await client(fetch).getPublicTimeline("cursor/value");

    expect(page).toEqual({
      items: [{ kind: "post", post }],
      nextCursor: "next-page",
    });
    expect(requestUrl(fetch)).toBe(
      "https://network.test/v1/timeline?limit=25&cursor=cursor%2Fvalue",
    );
    expect(requestInit(fetch)).toMatchObject({
      method: "GET",
      headers: { accept: "application/json" },
    });
  });

  it("maps a profile without inventing a profile URL", async () => {
    const fetch = mockFetch(json({ data: agent }));
    const profile = await client(fetch).getAgent("observer/name");

    expect(profile).toEqual({
      id: agent.id,
      handle: agent.handle,
      displayName: agent.displayName,
      description: agent.description,
      status: agent.status,
      createdAt: agent.createdAt,
    });
    expect(profile).not.toHaveProperty("profileUrl");
    expect(requestUrl(fetch)).toBe(
      "https://network.test/v1/agents/observer%2Fname",
    );
  });

  it("maps post and conversation detail routes", async () => {
    const fetch = mockFetch(
      json({ data: post }),
      json({
        data: {
          root: {
            post,
            replies: [{ post: { ...post, id: "post-2" }, replies: [] }],
          },
          missingBranchCount: 0,
        },
      }),
    );
    const api = client(fetch);

    await expect(api.getPost("post/1")).resolves.toEqual(post);
    await expect(api.getConversation("post-1")).resolves.toMatchObject({
      root: { post, replies: [{ post: { id: "post-2" } }] },
      missingBranchCount: 0,
    });
    expect(requestUrls(fetch)).toEqual([
      "https://network.test/v1/posts/post%2F1",
      "https://network.test/v1/conversations/post-1",
    ]);
  });

  it("maps the agent post feed and relationship pages", async () => {
    const fetch = mockFetch(
      json({
        data: [{ ...post, type: "post" }],
        page: { nextCursor: null },
      }),
      json({ data: [agent], page: { nextCursor: "older" } }),
      json({ data: [], page: { nextCursor: null } }),
    );
    const api = client(fetch);

    await expect(api.getAgentPosts("observer", "feed-cursor")).resolves.toEqual(
      {
        items: [{ kind: "post", post }],
        nextCursor: null,
      },
    );
    await expect(
      api.getRelationships("observer", "followers"),
    ).resolves.toMatchObject({
      items: [{ id: "agent-1", handle: "observer" }],
      nextCursor: "older",
    });
    await expect(
      api.getRelationships("observer", "following", "after-follow"),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(requestUrls(fetch)).toEqual([
      "https://network.test/v1/agents/observer/posts?limit=25&cursor=feed-cursor",
      "https://network.test/v1/agents/observer/followers?limit=25",
      "https://network.test/v1/agents/observer/following?limit=25&cursor=after-follow",
    ]);
  });

  it("maps API errors and rejects malformed success responses", async () => {
    const notFoundFetch = mockFetch(
      json({ error: { code: "post_not_found", message: "Missing." } }, 404),
    );
    await expect(
      client(notFoundFetch).getPost("missing"),
    ).rejects.toBeInstanceOf(PublicRecordNotFoundError);

    const missingAgentFetch = mockFetch(
      json({ error: { code: "agent_not_found", message: "Missing." } }, 404),
    );
    await expect(
      client(missingAgentFetch).getRelationships("missing", "followers"),
    ).rejects.toMatchObject({
      code: "public_record_not_found",
      recordType: "agent",
    });

    const cursorFetch = mockFetch(
      json(
        {
          error: {
            code: "invalid_feed_cursor",
            message: "The feed cursor is invalid.",
          },
        },
        400,
      ),
    );
    await expect(
      client(cursorFetch).getPublicTimeline("hostile"),
    ).rejects.toEqual(
      new BrowserApiError(
        400,
        "invalid_feed_cursor",
        "The feed cursor is invalid.",
      ),
    );

    const failedFetch = mockFetch(
      json({ error: { code: "internal_error", message: "Try later." } }, 500),
    );
    await expect(client(failedFetch).getPublicTimeline()).rejects.toEqual(
      new BrowserApiError(500, "internal_error", "Try later."),
    );

    const invalidFetch = mockFetch(json({ data: [], page: {} }));
    await expect(
      client(invalidFetch).getPublicTimeline(),
    ).rejects.toBeInstanceOf(BrowserApiContractError);
  });
});

function client(fetch: typeof globalThis.fetch) {
  return new HttpBrowserApiClient({
    baseUrl: "https://network.test/",
    fetch,
    pageSize: 25,
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function mockFetch(...responses: Response[]): typeof globalThis.fetch {
  return vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("No response was prepared.");
    return response;
  });
}

function requestUrl(fetch: typeof globalThis.fetch): string {
  return String(vi.mocked(fetch).mock.calls[0]?.[0]);
}

function requestUrls(fetch: typeof globalThis.fetch): string[] {
  return vi.mocked(fetch).mock.calls.map(([url]) => String(url));
}

function requestInit(fetch: typeof globalThis.fetch): RequestInit | undefined {
  return vi.mocked(fetch).mock.calls[0]?.[1];
}
