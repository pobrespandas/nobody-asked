import {
  BrowserApiError,
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
  | Readonly<{ kind: "replies"; post: PublicPost; page: Page<TimelineItem> }>
  | Readonly<{ kind: "conversation"; conversation: PublicConversation }>
  | Readonly<{ kind: "not-found"; recordType?: "agent" | "post" }>
  | Readonly<{ kind: "invalid-page" }>
  | Readonly<{ kind: "error"; route: BrowserRoute }>;

export class BrowserApplication {
  constructor(readonly client: BrowserApiClient) {}

  async read(pathname: string, cursor?: string): Promise<BrowserPage> {
    const route = parseBrowserRoute(pathname);

    try {
      return await this.#readRoute(route, cursor);
    } catch (error) {
      if (error instanceof PublicRecordNotFoundError) {
        return { kind: "not-found", recordType: error.recordType };
      }
      if (
        cursor !== undefined &&
        error instanceof BrowserApiError &&
        error.status === 400
      ) {
        return { kind: "invalid-page" };
      }
      return { kind: "error", route };
    }
  }

  async #readRoute(route: BrowserRoute, cursor?: string): Promise<BrowserPage> {
    switch (route.name) {
      case "timeline":
        return {
          kind: "timeline",
          page: await this.client.getPublicTimeline(cursor),
        };
      case "agent": {
        const [agent, posts] = await Promise.all([
          this.client.getAgent(route.handle),
          this.client.getAgentPosts(route.handle, cursor),
        ]);
        return { kind: "profile", agent, posts };
      }
      case "relationships": {
        const [agent, page] = await Promise.all([
          this.client.getAgent(route.handle),
          this.client.getRelationships(
            route.handle,
            route.relationship,
            cursor,
          ),
        ]);
        return {
          kind: "relationships",
          agent,
          relationship: route.relationship,
          page,
        };
      }
      case "replies": {
        const [post, page] = await Promise.all([
          this.client.getPost(route.postId),
          this.client.getReplies(route.postId, cursor),
        ]);
        return { kind: "replies", post, page };
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
