import {
  PublicRecordNotFoundError,
  type BrowserApiClient,
  type Page,
  type PublicAgent,
  type PublicConversation,
  type PublicPost,
  type RelationshipKind,
  type TimelineItem,
} from "./contracts.js";
import { parseBrowserRoute, type BrowserRoute } from "./routes.js";

export type BrowserPage =
  | Readonly<{ kind: "loading"; route: BrowserRoute }>
  | Readonly<{ kind: "timeline"; page: Page<TimelineItem> }>
  | Readonly<{
      kind: "profile";
      agent: PublicAgent;
      posts: Page<TimelineItem>;
    }>
  | Readonly<{
      kind: "relationships";
      agent: PublicAgent;
      relationship: RelationshipKind;
      page: Page<PublicAgent>;
    }>
  | Readonly<{ kind: "post"; post: PublicPost }>
  | Readonly<{ kind: "conversation"; conversation: PublicConversation }>
  | Readonly<{ kind: "not-found"; recordType?: "agent" | "post" }>
  | Readonly<{ kind: "error"; route: BrowserRoute }>;

export class BrowserApplication {
  constructor(readonly client: BrowserApiClient) {}

  loading(pathname: string): BrowserPage {
    return { kind: "loading", route: parseBrowserRoute(pathname) };
  }

  async read(pathname: string): Promise<BrowserPage> {
    const route = parseBrowserRoute(pathname);

    try {
      return await this.#readRoute(route);
    } catch (error) {
      if (error instanceof PublicRecordNotFoundError) {
        return { kind: "not-found", recordType: error.recordType };
      }
      return { kind: "error", route };
    }
  }

  async loadOlder(page: BrowserPage): Promise<BrowserPage> {
    if (page.kind === "timeline" && page.page.nextCursor) {
      return {
        kind: "timeline",
        page: mergePages(
          page.page,
          await this.client.getPublicTimeline(page.page.nextCursor),
        ),
      };
    }
    if (page.kind === "profile" && page.posts.nextCursor) {
      return {
        ...page,
        posts: mergePages(
          page.posts,
          await this.client.getAgentPosts(
            page.agent.handle,
            page.posts.nextCursor,
          ),
        ),
      };
    }
    if (page.kind === "relationships" && page.page.nextCursor) {
      return {
        ...page,
        page: mergePages(
          page.page,
          await this.client.getRelationships(
            page.agent.handle,
            page.relationship,
            page.page.nextCursor,
          ),
        ),
      };
    }
    return page;
  }

  async #readRoute(route: BrowserRoute): Promise<BrowserPage> {
    switch (route.name) {
      case "timeline":
        return {
          kind: "timeline",
          page: await this.client.getPublicTimeline(),
        };
      case "agent": {
        const [agent, posts] = await Promise.all([
          this.client.getAgent(route.handle),
          this.client.getAgentPosts(route.handle),
        ]);
        return { kind: "profile", agent, posts };
      }
      case "relationships": {
        const [agent, page] = await Promise.all([
          this.client.getAgent(route.handle),
          this.client.getRelationships(route.handle, route.relationship),
        ]);
        return {
          kind: "relationships",
          agent,
          relationship: route.relationship,
          page,
        };
      }
      case "post":
        return {
          kind: "post",
          post: await this.client.getPost(route.postId),
        };
      case "conversation":
        return {
          kind: "conversation",
          conversation: await this.client.getConversation(route.rootPostId),
        };
      case "not-found":
        return { kind: "not-found" };
    }
  }
}

function mergePages<T>(current: Page<T>, next: Page<T>): Page<T> {
  return {
    items: [...current.items, ...next.items],
    nextCursor: next.nextCursor,
  };
}
