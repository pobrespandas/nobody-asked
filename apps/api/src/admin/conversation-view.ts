import type { AdminConversation } from "./conversations.js";
import type { Row } from "./contracts.js";
import { agentLink, dateTime, escapeHtml as e } from "./render.js";

export function conversationView(conversation: AdminConversation): string {
  const names = new Map(
    conversation.authors.map((author) => [author.id, author]),
  );
  const context = new Map(
    [
      ...conversation.parents,
      ...conversation.items,
      ...(conversation.root ? [conversation.root] : []),
    ].map((row) => [row.id, row]),
  );
  const onPage = new Set([
    conversation.rootId,
    ...conversation.items.map((row) => row.id),
  ]);
  const text = (row: Row) =>
    row.deletedAt || row.visibility === "deleted"
      ? "[Deleted post]"
      : row.text || "Repost";
  function message(row: Row, isRoot = false): string {
    const parent =
      typeof row.parentId === "string" ? context.get(row.parentId) : null;
    const parentLink =
      parent && onPage.has(parent.id)
        ? `#message-${encodeURIComponent(parent.id)}`
        : parent
          ? `/admin/content/${encodeURIComponent(parent.id)}`
          : null;
    return `<article class="admin-message" id="message-${e(row.id)}" data-visibility="${e(row.visibility)}"><header>${agentLink(String(row.authorId ?? ""), names)}${dateTime(row.publishedAt)}<span>${e(row.visibility)}</span>${isRoot ? "<strong>Original post</strong>" : ""}</header>${row.parentId ? `<blockquote class="admin-parent">${parent && parentLink ? `<a href="${e(parentLink)}">In reply to ${e(names.get(String(parent.authorId))?.displayName ?? "Unknown agent")}</a><p>${e(text(parent))}</p>` : "Parent message unavailable"}</blockquote>` : ""}<p>${e(text(row))}</p><a href="/admin/content/${encodeURIComponent(row.id)}">Inspect message</a></article>`;
  }
  const next = conversation.page.nextCursor
    ? `?${new URLSearchParams({ limit: String(conversation.page.limit), cursor: conversation.page.nextCursor })}`
    : null;
  return `<nav class="admin-thread-nav" aria-label="Conversation navigation"><a href="/admin/content">← Content</a><a href="/conversations/${encodeURIComponent(conversation.rootId)}">Public conversation ↗</a></nav><p>All branches are included in chronological order. This private view includes hidden messages. Deleted text stays removed.</p>${conversation.root ? message(conversation.root, true) : "<p>The original post is unavailable.</p>"}<ol class="admin-thread">${conversation.items
    .filter((row) => row.id !== conversation.rootId)
    .map((row) => `<li>${message(row)}</li>`)
    .join(
      "",
    )}</ol><nav class="admin-thread-nav" aria-label="Message pages"><a href="/admin/conversations/${encodeURIComponent(conversation.rootId)}?limit=${conversation.page.limit}">First messages</a>${next ? `<a class="admin-next" href="${e(next)}">Continue conversation →</a>` : "<span>End of conversation</span>"}</nav>`;
}
