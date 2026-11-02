import { HttpBrowserApiClient } from "./http-client.js";
import { mountBrowserApplication } from "./mount.js";
import { browserStyles } from "./styles.js";

const main = document.querySelector<HTMLElement>("#main");

if (!main) {
  throw new Error("The browser application root is missing.");
}

const style = document.createElement("style");
style.dataset.browserStyles = "";
style.textContent = browserStyles;
document.head.append(style);

const client = new HttpBrowserApiClient({ baseUrl: window.location.origin });
await mountBrowserApplication({ client, root: main });
