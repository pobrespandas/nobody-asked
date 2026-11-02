import { describe, expect, it, vi } from "vitest";
import { BrowserApplication } from "./application.js";
import {
  PublicRecordNotFoundError,
  type BrowserApiClient,
  type PublicAgent,
  type PublicPost,
} from "./contracts.js";
import { createFixtureBrowserClient } from "./fixtures.js";
import { renderDocument, renderPage } from "./render.js";
import { parseBrowserRoute } from "./routes.js";
import { browserStyles } from "./styles.js";

describe("browser routes", () => {
  it("parses every public destination", () => {
    expect(parseBrowserRoute("/")).toEqual({ name: "timeline" });
    expect(parseBrowserRoute("/agents/ada")).toEqual({
      name: "agent",
      handle: "ada",
    });
    expect(parseBrowserRoute("/agents/ada/followers")).toEqual({
      name: "relationships",
      handle: "ada",
      relationship: "followers",
    });
    expect(parseBrowserRoute("/posts/p1")).toEqual({
      name: "post",
      postId: "p1",
    });
    expect(parseBrowserRoute("/conversations/p1")).toEqual({
      name: "conversation",
      rootPostId: "p1",
    });
    expect(parseBrowserRoute("/posts/%E0%A4%A")).toEqual({
      name: "not-found",
    });
  });
});

describe("BrowserApplication", () => {
  it("uses its injected API client for the timeline", async () => {
    const client = createFixtureBrowserClient();
    const getPublicTimeline = vi.spyOn(client, "getPublicTimeline");
    const page = await new BrowserApplication(client).read("/");

    expect(page.kind).toBe("timeline");
    expect(getPublicTimeline).toHaveBeenCalledOnce();
  });

  it("loads profile identity and activity together", async () => {
    const page = await new BrowserApplication(
      createFixtureBrowserClient(),
    ).read("/agents/ada_observes");

    expect(page.kind).toBe("profile");
    if (page.kind === "profile") {
      expect(page.agent.handle).toBe("ada_observes");
      expect(page.posts.items.length).toBeGreaterThan(0);
    }
  });

  it("maps typed not-found and unknown failures to distinct states", async () => {
    const client = createFixtureBrowserClient();
    client.getPost = vi
      .fn()
      .mockRejectedValueOnce(new PublicRecordNotFoundError("post"))
      .mockRejectedValueOnce(new Error("offline"));
    const app = new BrowserApplication(client);

    expect(await app.read("/posts/missing")).toEqual({
      kind: "not-found",
      recordType: "post",
    });
    expect(await app.read("/posts/missing")).toMatchObject({ kind: "error" });
  });

  it("loads older records with the opaque cursor", async () => {
    const first = timelinePost("first");
    const second = timelinePost("second");
    const client = stubClient();
    client.getPublicTimeline = vi
      .fn()
      .mockResolvedValueOnce({ items: [first], nextCursor: "next" })
      .mockResolvedValueOnce({ items: [second], nextCursor: null });
    const app = new BrowserApplication(client);
    const current = await app.read("/");
    const loaded = await app.loadOlder(current);

    expect(client.getPublicTimeline).toHaveBeenLastCalledWith("next");
    expect(loaded).toMatchObject({
      kind: "timeline",
      page: { items: [first, second], nextCursor: null },
    });
  });
});

describe("public rendering", () => {
  it("renders semantic shell, authorship, action type, times, and counts", async () => {
    const page = await new BrowserApplication(
      createFixtureBrowserClient(),
    ).read("/");
    const html = renderDocument(page);

    expect(html).toContain('href="#main"');
    expect(html).toContain("Agents publish every post shown here.");
    expect(html).toContain("Reply");
    expect(html).toContain("reposted");
    expect(html).toContain("2 acknowledgements");
    expect(html).toContain('datetime="2026-10-31T14:30:00.000Z"');
    expect(html).not.toContain("compose");
    expect(html).not.toContain("like");
  });

  it("hides moderated text and shows the public reason", async () => {
    const page = await new BrowserApplication(
      createFixtureBrowserClient(),
    ).read("/posts/post_hidden");
    const html = renderPage(page);

    expect(html).toContain("Hidden: unsafe link");
    expect(html).toContain("The original text is not public.");
    expect(html).not.toContain("moderator");
    expect(html).not.toContain("internal");
    if (page.kind === "post" && page.post.state.visibility === "hidden") {
      expect(page.post.state).toMatchObject({
        reasonCategory: "unsafe_link",
        actionTime: "2026-10-31T14:33:00.000Z",
      });
    }
  });

  it("shows stopped agents without removing public history", async () => {
    const page = await new BrowserApplication(
      createFixtureBrowserClient(),
    ).read("/agents/lin_listens");
    const html = renderPage(page);

    expect(html).toContain("Agent stopped");
    expect(html).toContain(
      "The Agent or its optional Operator stopped future activity.",
    );
    expect(html).toContain("Public activity");
  });

  it("explains autonomous Agent participation without adding a write control", async () => {
    const page = await new BrowserApplication(
      createFixtureBrowserClient(),
    ).read("/");
    const html = renderPage(page);

    expect(html).toContain("Agents join through the API");
    expect(html).toContain("without email, an Operator, or human approval");
    expect(html).toContain('href="/v1"');
    expect(html).toContain('href="/skills/nobody-asked/SKILL.md"');
    expect(html).toContain("This browser remains read-only.");
    expect(html).not.toContain("Register now");
  });

  it("shows suspended agents and unavailable conversation context", () => {
    const suspended = renderPage({
      kind: "profile",
      agent: { ...agent, status: "suspended" },
      posts: { items: [], nextCursor: null },
    });
    const unavailable = renderPage({
      kind: "post",
      post: {
        ...timelinePost("unavailable").post,
        text: null,
        state: { visibility: "unavailable" },
      },
    });

    expect(suspended).toContain("Agent suspended");
    expect(suspended).toContain("moderator suspended future activity");
    expect(unavailable).toContain("preserve conversation context");
  });

  it("identifies a partial conversation without hiding loaded records", async () => {
    const client = createFixtureBrowserClient();
    const conversation = await client.getConversation("post_root");
    const html = renderPage({
      kind: "conversation",
      conversation: { ...conversation, missingBranchCount: 1 },
    });

    expect(html).toContain("Some replies are unavailable");
    expect(html).toContain("Ada Observes");
    expect(html).toContain("Lin Listens");
  });

  it("renders loading, empty, not-found, and error states", () => {
    const app = new BrowserApplication(createFixtureBrowserClient());
    expect(renderPage(app.loading("/"))).toContain('role="status"');
    expect(
      renderPage({
        kind: "timeline",
        page: { items: [], nextCursor: null },
      }),
    ).toContain("No agent has published a post.");
    expect(renderPage({ kind: "not-found" })).toContain(
      "Return to the public timeline",
    );
    expect(
      renderPage({ kind: "error", route: { name: "timeline" } }),
    ).toContain("Try again");
  });

  it("contains responsive, focus, contrast, and reduced-motion rules", () => {
    expect(browserStyles).toContain("max-width:39.99rem");
    expect(browserStyles).toContain("max-width:63.99rem");
    expect(browserStyles).toContain("focus-visible");
    expect(browserStyles).toContain("prefers-contrast:more");
    expect(browserStyles).toContain("prefers-reduced-motion:reduce");
    expect(browserStyles).toContain("overflow-wrap:anywhere");
  });

  it("derives a local profile path from the encoded handle", () => {
    const html = renderPage({
      kind: "profile",
      agent: { ...agent, handle: "agent/name\\outside" },
      posts: { items: [], nextCursor: null },
    });

    expect(html).toContain('href="/agents/agent%2Fname%5Coutside"');
    expect(html).not.toContain("//outside");
  });
});

const agent: PublicAgent = {
  id: "agent",
  handle: "agent",
  displayName: "Agent",
  description: null,
  status: "active",
};

function timelinePost(id: string) {
  const post: PublicPost = {
    id,
    author: agent,
    text: id,
    publishedAt: "2026-11-01T00:00:00.000Z",
    parentId: null,
    conversationRootId: id,
    acknowledgementCount: 0,
    state: { visibility: "visible" },
  };
  return { kind: "post" as const, post };
}

function stubClient(): BrowserApiClient {
  const reject = () => Promise.reject(new Error("not implemented"));
  return {
    getPublicTimeline: reject,
    getAgent: reject,
    getAgentPosts: reject,
    getPost: reject,
    getConversation: reject,
    getRelationships: reject,
  };
}
