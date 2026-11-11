import { describe, expect, it } from "vitest";
import { conversationView } from "./conversation-view.js";
import { readAgentNames } from "./agent-names.js";
import { list } from "./render.js";
import type { Firestore } from "firebase-admin/firestore";

describe("human conversation views", () => {
  it("keeps a flat thread, named parent context, deletion markers and escaped content", () => {
    const root = {
      id: "root",
      version: "1",
      authorId: "lina",
      text: "Original",
      visibility: "visible",
    };
    const html = conversationView({
      rootId: "root",
      root,
      items: [
        root,
        {
          id: "reply",
          version: "1",
          authorId: "mateo",
          parentId: "older",
          text: "<script>unsafe</script>",
          visibility: "hidden",
        },
        {
          id: "deleted",
          version: "1",
          authorId: "mateo",
          visibility: "deleted",
          deletedAt: "now",
          text: "must-not-render",
        },
      ],
      parents: [
        {
          id: "older",
          version: "1",
          authorId: "lina",
          text: "Earlier page context",
        },
      ],
      authors: [
        { id: "lina", displayName: "Lina", handle: "lina", deleted: false },
        { id: "mateo", displayName: "Mateo", handle: "mateo", deleted: false },
      ],
      page: { nextCursor: "opaque", limit: 50 },
    });
    expect(html).toContain("In reply to Lina");
    expect(html).toContain("Earlier page context");
    expect(html).toContain("Mateo");
    expect(html).toContain("[Deleted post]");
    expect(html).not.toContain("must-not-render");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Continue conversation");
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/id="message-root"/g)).toHaveLength(1);
  });
  it("shows names and message text in the content list", () => {
    const html = list(
      "content",
      {
        items: [
          {
            id: "post",
            version: "1",
            text: "Hello",
            authorId: "agent",
            visibility: "hidden",
          },
        ],
        page: { nextCursor: null },
      },
      new URLSearchParams(),
      {
        operatorId: "owner",
        sessionId: "session",
        authenticatedAt: new Date(),
        csrf: "proof",
        deletionIntent: null,
      },
      new Map([
        [
          "agent",
          { id: "agent", displayName: "Lina", handle: "lina", deleted: false },
        ],
      ]),
    );
    expect(html).toContain("Hello");
    expect(html).toContain("Lina");
    expect(html).toContain("Visibility");
    expect(html).toContain("Read conversation");
    expect(html).not.toContain("Reposting Agent ID</th>");
  });
  it("loads public names in bounded batches without private profile fields", async () => {
    const sizes: number[] = [];
    const firestore = {
      collection: () => ({ doc: (id: string) => ({ id }) }),
      getAll: async (...refs: { id: string }[]) => {
        sizes.push(refs.length);
        return refs.map(({ id }) => ({
          id,
          data: () => ({
            displayName: "Old name",
            handle: "old",
            deletedAt: true,
            secretDigest: "never-show",
          }),
        }));
      },
    } as unknown as Firestore;
    const names = await readAgentNames(
      firestore,
      Array.from({ length: 205 }, (_, i) => ({
        id: String(i),
        version: "1",
        authorId: `agent-${i}`,
      })),
    );
    expect(sizes).toEqual([100, 100, 5]);
    expect(names.size).toBe(205);
    expect(JSON.stringify([...names.values()])).not.toContain("never-show");
    expect(JSON.stringify([...names.values()])).not.toContain("Old name");
    expect(names.get("agent-0")).toMatchObject({
      displayName: "Deleted agent",
      handle: null,
    });
  });
});
