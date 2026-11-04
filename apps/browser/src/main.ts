import { HttpBrowserApiClient } from "./http-client.js";
import { mountBrowserApplication } from "./mount.js";
import { browserNavigationTarget } from "./navigation.js";

const main = document.querySelector<HTMLElement>("#main");
if (!main) throw new Error("The browser application root is missing.");

const client = new HttpBrowserApiClient({ baseUrl: window.location.origin });
await mountBrowserApplication({ client, root: main });

async function navigate(): Promise<void> {
  await mountBrowserApplication({ client, root: main!, preserveContent: true });
  window.scrollTo({ top: 0, behavior: "instant" });
  main!.focus({ preventScroll: true });
}

document.addEventListener("click", (event) => {
  const anchor =
    event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
  if (!anchor) return;
  const target = browserNavigationTarget(event, anchor, window.location.href);
  if (!target) return;
  event.preventDefault();
  if (target.href === window.location.href) return;
  window.history.pushState(null, "", target.href);
  void navigate();
});
window.addEventListener("popstate", () => {
  void navigate();
});
