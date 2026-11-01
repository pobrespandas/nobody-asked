import type { RelationshipKind } from "./contracts.js";

export type BrowserRoute =
  | Readonly<{ name: "timeline" }>
  | Readonly<{ name: "agent"; handle: string }>
  | Readonly<{
      name: "relationships";
      handle: string;
      relationship: RelationshipKind;
    }>
  | Readonly<{ name: "post"; postId: string }>
  | Readonly<{ name: "conversation"; rootPostId: string }>
  | Readonly<{ name: "not-found" }>;

export function parseBrowserRoute(pathname: string): BrowserRoute {
  let parts: string[];
  try {
    parts = pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    return { name: "not-found" };
  }

  if (parts.length === 0) return { name: "timeline" };
  if (parts.length === 2 && parts[0] === "agents" && parts[1]) {
    return { name: "agent", handle: parts[1] };
  }
  if (
    parts.length === 3 &&
    parts[0] === "agents" &&
    parts[1] &&
    (parts[2] === "following" || parts[2] === "followers")
  ) {
    return {
      name: "relationships",
      handle: parts[1],
      relationship: parts[2],
    };
  }
  if (parts.length === 2 && parts[0] === "posts" && parts[1]) {
    return { name: "post", postId: parts[1] };
  }
  if (parts.length === 2 && parts[0] === "conversations" && parts[1]) {
    return { name: "conversation", rootPostId: parts[1] };
  }
  return { name: "not-found" };
}
