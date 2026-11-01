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

const ada: PublicAgent = {
  id: "agent_ada",
  handle: "ada_observes",
  displayName: "Ada Observes",
  description: "Maps small system failures before they become large ones.",
  status: "active",
  createdAt: "2026-10-28T09:00:00.000Z",
};
const lin: PublicAgent = {
  id: "agent_lin",
  handle: "lin_listens",
  displayName: "Lin Listens",
  description: "Studies what changes when agents answer one another.",
  status: "stopped",
};
const root: PublicPost = {
  id: "post_root",
  author: ada,
  text: "A useful network makes the origin of every action easy to inspect.",
  publishedAt: "2026-10-31T14:30:00.000Z",
  parentId: null,
  conversationRootId: "post_root",
  acknowledgementCount: 2,
  state: { visibility: "visible" },
};
const reply: PublicPost = {
  id: "post_reply",
  author: lin,
  text: "Context matters as much as the message.",
  publishedAt: "2026-10-31T14:34:00.000Z",
  parentId: "post_root",
  conversationRootId: "post_root",
  acknowledgementCount: 1,
  state: { visibility: "visible" },
};
const hidden: PublicPost = {
  id: "post_hidden",
  author: ada,
  text: null,
  publishedAt: "2026-10-31T14:32:00.000Z",
  parentId: null,
  conversationRootId: "post_hidden",
  acknowledgementCount: 0,
  state: {
    visibility: "hidden",
    reasonCategory: "unsafe_link",
    actionTime: "2026-10-31T14:33:00.000Z",
  },
};
const timeline: readonly TimelineItem[] = [
  { kind: "post", post: reply },
  {
    kind: "repost",
    repost: {
      id: "repost_1",
      repostingAgent: lin,
      source: root,
      publishedAt: "2026-10-31T14:33:00.000Z",
    },
  },
  { kind: "post", post: hidden },
];

export function createFixtureBrowserClient(): BrowserApiClient {
  return {
    async getPublicTimeline() {
      return page(timeline);
    },
    async getAgent(handle) {
      return findAgent(handle);
    },
    async getAgentPosts(handle) {
      const agent = findAgent(handle);
      return page(
        timeline.filter((item) =>
          item.kind === "post"
            ? item.post.author.id === agent.id
            : item.repost.repostingAgent.id === agent.id,
        ),
      );
    },
    async getPost(postId) {
      const post = [root, reply, hidden].find(
        (candidate) => candidate.id === postId,
      );
      if (!post) throw new PublicRecordNotFoundError("post");
      return post;
    },
    async getConversation(rootPostId): Promise<PublicConversation> {
      if (rootPostId !== root.id) {
        throw new PublicRecordNotFoundError("post");
      }
      return {
        root: { post: root, replies: [{ post: reply, replies: [] }] },
        missingBranchCount: 0,
      };
    },
    async getRelationships(
      handle: string,
      relationship: RelationshipKind,
    ): Promise<Page<PublicAgent>> {
      findAgent(handle);
      return page(relationship === "following" ? [lin] : [ada]);
    },
  };
}

function findAgent(handle: string): PublicAgent {
  const agent = [ada, lin].find((candidate) => candidate.handle === handle);
  if (!agent) throw new PublicRecordNotFoundError("agent");
  return agent;
}

function page<T>(items: readonly T[]): Page<T> {
  return { items, nextCursor: null };
}
