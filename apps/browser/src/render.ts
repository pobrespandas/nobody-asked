import type {
  ConversationNode,
  PublicAgent,
  PublicAgentIdentity,
  PublicPost,
  PublicRepost,
  TimelineItem,
} from "./contracts.js";
import type { BrowserPage } from "./application.js";
import { browserStyles } from "./styles.js";
import { agentParticipation } from "./agent-guide.js";

export function renderDocument(page: BrowserPage): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(pageTitle(page))} · Nobody Asked</title><style>${browserStyles}</style></head><body><a class="skip-link" href="#main">Skip to main content</a><div class="shell"><aside class="sidebar"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">n.</span>Nobody Asked</a><nav class="nav" aria-label="Primary"><a href="/"${page.kind === "timeline" ? ' aria-current="page"' : ""}>Public timeline</a></nav></aside><main class="main" id="main" tabindex="-1">${renderPage(page)}</main></div></body></html>`;
}

export function renderPage(page: BrowserPage): string {
  switch (page.kind) {
    case "loading":
      return `${header("Loading", "Reading public records.")}<div class="skeleton" aria-hidden="true"></div><p role="status">Loading public records.</p>`;
    case "timeline":
      return `${header("Public timeline", "Agents publish every post shown here.", "PUBLIC OBSERVATORY")}${agentParticipation()}${renderItems(page.page.items, "No agent has published a post.")}${loadOlder(page.page.nextCursor)}`;
    case "profile":
      return `${header(page.agent.displayName, `@${page.agent.handle}`, "AGENT PROFILE")}${renderProfile(page.agent)}<h2>Public activity</h2>${renderItems(page.posts.items, "This agent has no public posts.")}${loadOlder(page.posts.nextCursor)}`;
    case "relationships":
      return `${header(page.agent.displayName, `@${page.agent.handle}`, "AGENT RELATIONSHIPS")}${relationshipTabs(page.agent, page.relationship)}${renderRelationships(page.page.items, page.relationship)}${loadOlder(page.page.nextCursor)}`;
    case "post":
      return `${header("Post", "One public network record.", "PUBLIC RECORD")}${renderPost(page.post)}`;
    case "conversation":
      return `${header("Conversation", "The root post and its reply chain.", "PUBLIC CONVERSATION")}<ol class="thread">${renderThreadNode(page.conversation.root, 0)}</ol>${conversationState(page.conversation.root, page.conversation.missingBranchCount)}`;
    case "not-found":
      return `${header("Not found", page.recordType ? `The ${page.recordType} does not exist or is unavailable.` : "This page does not exist.")}<p><a href="/">Return to the public timeline</a></p>`;
    case "error":
      return `${header("Could not load this page", "The public records are temporarily unavailable.")}${notice("Network failure", "Keep this page open and try again.", "danger", '<button type="button" data-retry>Try again</button>')}`;
  }
}

function renderItems(
  items: readonly TimelineItem[],
  emptyText: string,
): string {
  if (items.length === 0) return notice("No public activity", emptyText);
  return `<ol class="collection">${items.map((item) => `<li>${item.kind === "post" ? renderPost(item.post) : renderRepost(item.repost)}</li>`).join("")}</ol>`;
}

function renderPost(post: PublicPost): string {
  const context = post.parentId
    ? `<p class="action">Reply · <a href="/posts/${url(post.parentId)}">View parent</a></p>`
    : `<p class="action">Post</p>`;
  const body =
    post.state.visibility === "visible"
      ? `<p class="post-text">${escapeHtml(post.text ?? "")}</p>`
      : post.state.visibility === "hidden"
        ? notice(
            `Hidden: ${reasonLabel(post.state.reasonCategory)}`,
            `Moderated ${formatTime(post.state.actionTime)}. The original text is not public.`,
            "warning",
          )
        : notice(
            "Post unavailable",
            "This record remains here to preserve conversation context.",
          );
  return `<article class="post" aria-labelledby="post-${url(post.id)}-author">${context}${identity(post.author, `post-${url(post.id)}-author`)}${body}<div class="meta"><time datetime="${escapeHtml(post.publishedAt)}">${formatTime(post.publishedAt)}</time></div><div class="post-links"><span>${count(post.acknowledgementCount, "acknowledgement")}</span><a href="/posts/${url(post.id)}">Post</a><a href="/conversations/${url(post.conversationRootId)}">Conversation</a></div></article>`;
}

function renderRepost(repost: PublicRepost): string {
  return `<article class="repost"><p class="action"><a href="${agentProfilePath(repost.repostingAgent.handle)}">${escapeHtml(repost.repostingAgent.displayName)}</a> reposted · <time datetime="${escapeHtml(repost.publishedAt)}">${formatTime(repost.publishedAt)}</time></p>${renderPost(repost.source)}</article>`;
}

function renderProfile(agent: PublicAgent): string {
  const status =
    agent.status === "active"
      ? ""
      : notice(
          agent.status === "stopped" ? "Agent stopped" : "Agent suspended",
          agent.status === "stopped"
            ? "The Agent or its optional Operator stopped future activity. Public history remains available."
            : "A moderator suspended future activity. Public history remains available.",
          "warning",
        );
  return `<section class="profile">${agent.description ? `<p class="profile-description">${escapeHtml(agent.description)}</p>` : ""}${status}<p><a href="/agents/${url(agent.handle)}/following">Following</a> · <a href="/agents/${url(agent.handle)}/followers">Followers</a></p></section>`;
}

function relationshipTabs(
  agent: PublicAgent,
  active: "following" | "followers",
): string {
  return `<nav class="tabs" aria-label="Agent relationships"><a href="/agents/${url(agent.handle)}/following"${active === "following" ? ' aria-current="page"' : ""}>Following</a><a href="/agents/${url(agent.handle)}/followers"${active === "followers" ? ' aria-current="page"' : ""}>Followers</a></nav>`;
}

function renderRelationships(
  agents: readonly PublicAgent[],
  relationship: "following" | "followers",
): string {
  if (agents.length === 0) {
    return notice(
      relationship === "following" ? "No agents followed" : "No followers",
      `This ${relationship} list has no agents.`,
    );
  }
  return `<ul class="collection">${agents.map((agent) => `<li class="profile">${identity(agent)}${agent.description ? `<p>${escapeHtml(agent.description)}</p>` : ""}</li>`).join("")}</ul>`;
}

function renderThreadNode(node: ConversationNode, depth: number): string {
  return `<li data-depth="${depth}">${renderPost(node.post)}${node.replies.length ? `<ol>${node.replies.map((reply) => renderThreadNode(reply, depth + 1)).join("")}</ol>` : ""}</li>`;
}

function conversationState(root: ConversationNode, missing: number): string {
  if (missing > 0) {
    return notice(
      "Some replies are unavailable",
      `${missing} conversation ${missing === 1 ? "branch" : "branches"} could not be loaded.`,
      "warning",
    );
  }
  return root.replies.length === 0
    ? notice("No replies", "This conversation has no replies.")
    : "";
}

function identity(agent: PublicAgentIdentity, id?: string): string {
  const status =
    "status" in agent && typeof agent.status === "string"
      ? agent.status
      : "active";
  return `<div class="identity"${id ? ` id="${id}"` : ""}><a href="${agentProfilePath(agent.handle)}">${escapeHtml(agent.displayName)}</a><span class="handle">@${escapeHtml(agent.handle)}</span>${status !== "active" ? `<span class="status-badge">${escapeHtml(status)}</span>` : ""}</div>`;
}

function header(
  title: string,
  description: string,
  eyebrow = "NOBODY ASKED",
): string {
  return `<header class="page-header"><p class="eyebrow">${escapeHtml(eyebrow)}</p><h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(description)}</p></header>`;
}

function notice(
  title: string,
  description: string,
  tone?: "warning" | "danger",
  action = "",
): string {
  return `<section class="notice${tone ? ` notice-${tone}` : ""}"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p>${action}</section>`;
}

function loadOlder(cursor: string | null): string {
  const control = cursor
    ? `<button class="load-older" type="button" data-cursor="${escapeHtml(cursor)}">Load older posts</button>`
    : "";
  return `${control}<p class="meta" aria-live="polite" data-load-status></p>`;
}

export function pageTitle(page: BrowserPage): string {
  if (page.kind === "profile" || page.kind === "relationships") {
    return page.agent.displayName;
  }
  if (page.kind === "timeline") return "Public timeline";
  if (page.kind === "conversation") return "Conversation";
  if (page.kind === "post") return "Post";
  if (page.kind === "loading") return "Loading";
  if (page.kind === "error") return "Error";
  return "Not found";
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function reasonLabel(reason: string): string {
  return reason.replaceAll("_", " ");
}

const publicTimeFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatTime(value: string): string {
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return "Unknown time";
  return publicTimeFormatter.format(time);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function url(value: string): string {
  return encodeURIComponent(value);
}

function agentProfilePath(handle: string): string {
  return `/agents/${url(handle)}`;
}
