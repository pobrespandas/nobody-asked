import { BrowserApplication } from "./application.js";
import type { BrowserApiClient } from "./contracts.js";
import { pageTitle, renderPage } from "./render.js";

export interface BrowserMountOptions {
  readonly client: BrowserApiClient;
  readonly root: HTMLElement;
  readonly location?: Location;
  readonly preserveContent?: boolean;
}

const mountControllers = new WeakMap<HTMLElement, AbortController>();

export async function mountBrowserApplication(
  options: BrowserMountOptions,
): Promise<void> {
  mountControllers.get(options.root)?.abort();
  const controller = new AbortController();
  mountControllers.set(options.root, controller);

  const location = options.location ?? window.location;
  const application = new BrowserApplication(options.client);
  options.root.setAttribute?.("aria-busy", "true");
  if (!options.preserveContent) {
    options.root.innerHTML = renderPage(application.loading(location.pathname));
  }
  let page = await application.read(location.pathname);
  if (controller.signal.aborted) return;
  options.root.innerHTML = renderPage(page);
  options.root.removeAttribute?.("aria-busy");
  if (options.root.ownerDocument) {
    options.root.ownerDocument.title = `${pageTitle(page)} · Nobody Asked`;
  }

  options.root.addEventListener(
    "click",
    async (event) => {
      const target = event.target as Element;
      if (target.closest("[data-retry]")) {
        await mountBrowserApplication(options);
        return;
      }

      const button = target.closest<HTMLButtonElement>("[data-cursor]");
      if (button) {
        button.disabled = true;
        const previousCount = itemCount(page);
        try {
          page = await application.loadOlder(page);
          if (controller.signal.aborted) return;
          options.root.innerHTML = renderPage(page);
          const addedCount = itemCount(page) - previousCount;
          setLoadStatus(options.root, `${addedCount} public records added.`);
          const nextButton =
            options.root.querySelector<HTMLButtonElement>("[data-cursor]");
          if (nextButton) {
            nextButton.focus({ preventScroll: true });
          } else {
            options.root.focus({ preventScroll: true });
          }
        } catch {
          if (controller.signal.aborted) return;
          button.disabled = false;
          setLoadStatus(options.root, "Could not load older posts. Try again.");
          button.focus({ preventScroll: true });
        }
      }
    },
    { signal: controller.signal },
  );
}

function setLoadStatus(root: HTMLElement, message: string): void {
  const status = root.querySelector<HTMLElement>("[data-load-status]");
  if (status) status.textContent = message;
}

function itemCount(
  page: Awaited<ReturnType<BrowserApplication["read"]>>,
): number {
  if (page.kind === "timeline" || page.kind === "relationships") {
    return page.page.items.length;
  }
  return page.kind === "profile" ? page.posts.items.length : 0;
}
