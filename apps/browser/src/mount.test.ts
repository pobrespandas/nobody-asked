import { describe, expect, it, vi } from "vitest";
import { createFixtureBrowserClient } from "./fixtures.js";
import { mountBrowserApplication } from "./mount.js";

describe("browser DOM adapter", () => {
  it("keeps one delegated listener when the root is remounted", async () => {
    const root = new FakeRoot();
    const options = {
      client: createFixtureBrowserClient(),
      root: root.asElement(),
      location: { pathname: "/" } as Location,
    };

    await mountBrowserApplication(options);
    await mountBrowserApplication(options);

    expect(root.listenerCount).toBe(1);
    expect(root.focusCount).toBe(0);
  });

  it("keeps the current page visible until navigation completes", async () => {
    const root = new FakeRoot();
    const client = createFixtureBrowserClient();
    await mountBrowserApplication({
      client,
      root: root.asElement(),
      location: { pathname: "/" } as Location,
    });
    const previous = root.html;
    let finish!: (value: { items: never[]; nextCursor: null }) => void;
    client.getPublicTimeline = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = mountBrowserApplication({
      client,
      root: root.asElement(),
      location: { pathname: "/" } as Location,
      preserveContent: true,
    });
    expect(root.html).toBe(previous);
    finish({ items: [], nextCursor: null });
    await pending;
    expect(root.html).toContain("No agent has published a post.");
  });

  it("replaces the listener during retry instead of accumulating it", async () => {
    const root = new FakeRoot();
    const client = createFixtureBrowserClient();
    client.getPublicTimeline = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ items: [], nextCursor: null });
    const options = {
      client,
      root: root.asElement(),
      location: { pathname: "/" } as Location,
    };

    await mountBrowserApplication(options);
    expect(root.html).toContain("data-retry");
    await root.click("[data-retry]");

    expect(root.listenerCount).toBe(1);
    expect(root.html).toContain("No agent has published a post.");
  });

  it("restores the paging button and announces a paging failure", async () => {
    const root = new FakeRoot();
    const client = createFixtureBrowserClient();
    client.getPublicTimeline = vi
      .fn()
      .mockResolvedValueOnce({ items: [], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("offline"));

    await mountBrowserApplication({
      client,
      root: root.asElement(),
      location: { pathname: "/" } as Location,
    });
    const button = root.loadButton;
    await root.click("[data-cursor]");

    expect(button?.disabled).toBe(false);
    expect(button?.focusCount).toBe(1);
    expect(root.status?.textContent).toBe(
      "Could not load older posts. Try again.",
    );
    expect(root.html).toContain("No agent has published a post.");
  });
});

class FakeRoot {
  html = "";
  loadButton: FakeControl | null = null;
  retryButton: FakeControl | null = null;
  status: FakeStatus | null = null;
  focusCount = 0;
  readonly #listeners = new Set<(event: Event) => unknown>();

  get listenerCount(): number {
    return this.#listeners.size;
  }

  asElement(): HTMLElement {
    return this as unknown as HTMLElement;
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.html = value;
    this.loadButton = value.includes("data-cursor") ? new FakeControl() : null;
    this.retryButton = value.includes("data-retry") ? new FakeControl() : null;
    this.status = value.includes("data-load-status") ? new FakeStatus() : null;
  }

  focus(): void {
    this.focusCount += 1;
  }

  querySelector<T>(selector: string): T | null {
    if (selector === "[data-cursor]") return this.loadButton as T | null;
    if (selector === "[data-retry]") return this.retryButton as T | null;
    if (selector === "[data-load-status]") return this.status as T | null;
    return null;
  }

  addEventListener(
    _type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void {
    const callback =
      typeof listener === "function"
        ? listener
        : (event: Event) => listener.handleEvent(event);
    this.#listeners.add(callback);
    const signal = typeof options === "object" ? options.signal : undefined;
    signal?.addEventListener("abort", () => this.#listeners.delete(callback), {
      once: true,
    });
  }

  async click(selector: "[data-cursor]" | "[data-retry]"): Promise<void> {
    const control =
      selector === "[data-cursor]" ? this.loadButton : this.retryButton;
    const target = {
      closest: (candidate: string) => (candidate === selector ? control : null),
    } as unknown as Element;
    await Promise.all(
      [...this.#listeners].map((listener) =>
        Promise.resolve(listener({ target } as unknown as Event)),
      ),
    );
  }
}

class FakeControl {
  disabled = false;
  focusCount = 0;

  focus(): void {
    this.focusCount += 1;
  }
}

class FakeStatus {
  textContent = "";
}
