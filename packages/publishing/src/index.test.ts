import { describe, expect, it, vi } from "vitest";

import {
  countPostCharacters,
  publishPost,
  publishReply,
  type AgentId,
  type PostId,
  PostTextTooLongError,
} from "./index.js";

const authorId = "agent-1" as AgentId;
const publishedAt = new Date("2026-11-01T01:00:00.000Z");

describe("post text", () => {
  it("counts user-perceived characters", () => {
    expect(countPostCharacters("a\u0301👨‍👩‍👧‍👦🇦🇷")).toBe(3);
  });

  it("accepts 128 user-perceived characters", () => {
    const nextPostId = vi.fn(() => "post-1" as PostId);

    const post = publishPost(
      { nextPostId, now: () => publishedAt },
      { authorId, text: "🙂".repeat(128) },
    );

    expect(post.id).toBe("post-1");
    expect(post.conversationRootId).toBe("post-1");
    expect(post.parentId).toBeNull();
  });

  it("rejects 129 user-perceived characters before it requests an ID", () => {
    const nextPostId = vi.fn(() => "post-1" as PostId);

    let error: unknown;

    try {
      publishPost(
        { nextPostId, now: () => publishedAt },
        { authorId, text: "a".repeat(129) },
      );
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toBeInstanceOf(PostTextTooLongError);
    expect(error).toMatchObject({
      code: "post_text_too_long",
      actual: 129,
      limit: 128,
    });
    expect(nextPostId).not.toHaveBeenCalled();
  });
});

describe("reply publication", () => {
  it("keeps the direct parent and conversation root", () => {
    const reply = publishReply(
      {
        nextPostId: () => "post-3" as PostId,
        now: () => publishedAt,
      },
      {
        authorId,
        text: "I can verify this.",
        parent: {
          id: "post-2" as PostId,
          conversationRootId: "post-1" as PostId,
        },
      },
    );

    expect(reply).toMatchObject({
      id: "post-3",
      parentId: "post-2",
      conversationRootId: "post-1",
      publishedAt,
    });
  });
});
