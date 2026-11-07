import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { readFileSync } from "node:fs";
import { BrowserApplication } from "./application.js";
import { HttpBrowserApiClient } from "./http-client.js";
import { renderDocument } from "./render.js";

const gzipAsync = promisify(gzip);

export function createPublicHtml(api: (request: Request) => Promise<Response>) {
  const assets = new Map([
    [
      "/controls.svg",
      {
        body: new Uint8Array(
          readFileSync(new URL("../static/controls.svg", import.meta.url)),
        ),
        type: "image/svg+xml",
      },
    ],
    [
      "/brand.svg",
      {
        body: new Uint8Array(
          readFileSync(new URL("../static/brand.svg", import.meta.url)),
        ),
        type: "image/svg+xml",
      },
    ],
    [
      "/share-card.jpg",
      {
        body: new Uint8Array(
          readFileSync(new URL("../static/share-card.jpg", import.meta.url)),
        ),
        type: "image/jpeg",
      },
    ],
    [
      "/site.css",
      {
        body: new Uint8Array(
          readFileSync(new URL("../static/site.css", import.meta.url)),
        ),
        type: "text/css; charset=utf-8",
      },
    ],
  ]);
  const application = new BrowserApplication(
    new HttpBrowserApiClient({
      baseUrl: "https://public-api.internal/",
      pageSize: 12,
      fetch: (input, init) => api(new Request(input, init)),
    }),
  );

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      !["GET", "HEAD"].includes(request.method) ||
      /^\/(?:v1|health)(?:\/|$)/.test(url.pathname)
    ) {
      return undefined;
    }

    const asset = assets.get(url.pathname);
    if (asset) {
      return new Response(request.method === "HEAD" ? null : asset.body, {
        headers: {
          "content-type": asset.type,
          "cache-control": "no-cache",
        },
      });
    }

    const cursor = url.searchParams.get("cursor") ?? undefined;
    const page = await application.read(url.pathname, cursor);
    const status =
      page.kind === "not-found"
        ? 404
        : page.kind === "invalid-page"
          ? 400
          : page.kind === "error"
            ? 502
            : 200;
    const gzipAccepted = acceptsGzip(request.headers.get("accept-encoding"));
    let body: string | Uint8Array<ArrayBuffer> | null = null;
    if (request.method !== "HEAD") {
      const html = renderDocument(page, url.pathname, cursor);
      body = gzipAccepted ? new Uint8Array(await gzipAsync(html)) : html;
    }
    return new Response(body, {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        vary: "Accept-Encoding",
        ...(gzipAccepted ? { "content-encoding": "gzip" } : {}),
      },
    });
  };
}

function acceptsGzip(header: string | null): boolean {
  let wildcard = false;
  for (const entry of header?.toLowerCase().split(",") ?? []) {
    const [encoding, ...parameters] = entry.trim().split(";");
    const quality = parameters
      .map((parameter) => parameter.trim())
      .find((parameter) => parameter.startsWith("q="));
    const accepted = quality === undefined || Number(quality.slice(2)) > 0;
    if (encoding?.trim() === "gzip") return accepted;
    if (encoding?.trim() === "*") wildcard = accepted;
  }
  return wildcard;
}
