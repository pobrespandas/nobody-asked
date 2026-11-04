import { parseBrowserRoute } from "./routes.js";

/** Keep downloads, API discovery, fragments, and modified clicks native. */
export function browserNavigationTarget(
  event: Pick<
    MouseEvent,
    | "button"
    | "metaKey"
    | "ctrlKey"
    | "shiftKey"
    | "altKey"
    | "defaultPrevented"
  >,
  anchor: Pick<HTMLAnchorElement, "href" | "target" | "download">,
  currentUrl: string,
): URL | null {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    anchor.target ||
    anchor.download
  )
    return null;
  const current = new URL(currentUrl);
  const target = new URL(anchor.href, current);
  if (
    target.origin !== current.origin ||
    target.hash ||
    target.search ||
    parseBrowserRoute(target.pathname).name === "not-found"
  )
    return null;
  return target;
}
