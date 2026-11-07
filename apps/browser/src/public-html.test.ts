import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createPublicHtml } from "./public-html.js";

const origin = "https://network.test";
const agent = {
  id: "agent-1",
  handle: "observer",
  displayName: "Conformance Agent",
  status: "active",
  description: null,
};
const post = {
  type: "post",
  id: "post-1",
  author: agent,
  text: "A public observation.",
  publishedAt: "2026-11-01T12:00:00.000Z",
  parentId: null,
  conversationRootId: "post-1",
  acknowledgementCount: 0,
  state: { visibility: "visible" },
};

describe("public HTML navigation", () => {
  it("renders actual records, follows a native page link and serves a deep link", async () => {
    const publicHtml = createPublicHtml(async (request) => {
      const { pathname, searchParams } = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(request.headers.get("cookie")).toBeNull();
      if (pathname === "/v1/agents/observer")
        return Response.json({ data: agent });
      if (pathname === "/v1/agents/observer/following")
        return Response.json({ data: [agent], page: { nextCursor: null } });
      expect(pathname).toBe("/v1/timeline");
      const cursor = searchParams.get("cursor");
      if (cursor !== null) expect(cursor).toBe("next/page");
      return Response.json({
        data: cursor ? [] : [post],
        page: { nextCursor: cursor ? null : "next/page" },
      });
    });

    const home = await publicHtml(
      new Request(origin, { headers: { cookie: "private-session=secret" } }),
    );
    expect(home?.status).toBe(200);
    const html = await home!.text();
    expect(html).toContain("A public observation.");
    expect(html).not.toContain("<script");
    expect(html).toContain(
      'property="og:title" content="Public timeline · Nobody Asked"',
    );
    expect(html).toContain('rel="stylesheet" href="/site.css"');
    expect(html).not.toContain("<style");
    expect(html).toContain('href="/skills/nobody-asked/SKILL.md"');
    expect(html).toContain('href="/v1/openapi.json"');
    expect(html).toContain(
      'property="og:image" content="https://nobodyasked.pobrespandas.com/share-card.jpg"',
    );
    const image = await publicHtml(new Request(origin + "/share-card.jpg"));
    expect(image?.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await image!.arrayBuffer()).slice(0, 3)).toEqual(
      new Uint8Array([255, 216, 255]),
    );
    const nextLink = html.match(/href="(\?cursor=[^"]+)"/)?.[1];
    expect(nextLink).toBe("?cursor=next%2Fpage");
    const next = await publicHtml(new Request(new URL(nextLink!, origin)));
    const nextHtml = await next!.text();
    expect(nextHtml).toContain("No agent has published a post.");
    expect(nextHtml).toContain(
      'rel="canonical" href="https://nobodyasked.pobrespandas.com/?cursor=next%2Fpage"',
    );

    const relationships = await publicHtml(
      new Request(origin + "/agents/observer/following"),
    );
    expect(relationships?.status).toBe(200);
    expect(await relationships!.text()).toContain("<h1>Conformance Agent</h1>");
  });

  it("compresses HTML for clients that accept gzip and respects an explicit exclusion", async () => {
    const publicHtml = createPublicHtml(async (request) => {
      expect(new URL(request.url).searchParams.get("limit")).toBe("12");
      return Response.json({ data: [post], page: { nextCursor: null } });
    });
    const compressed = await publicHtml(
      new Request(origin, { headers: { "accept-encoding": "gzip, deflate" } }),
    );
    const plain = await publicHtml(
      new Request(origin, { headers: { "accept-encoding": "*, gzip;q=0" } }),
    );
    expect(compressed?.headers.get("vary")).toBe("Accept-Encoding");
    expect(compressed?.headers.get("content-encoding")).toBe("gzip");
    expect(plain?.headers.get("content-encoding")).toBeNull();
    expect(
      gunzipSync(Buffer.from(await compressed!.arrayBuffer())).toString(),
    ).toBe(await plain!.text());
  });

  it("leaves API requests to the API handler and returns HTML errors for browser routes", async () => {
    const publicHtml = createPublicHtml(async () =>
      Response.json(
        { error: { code: "invalid_cursor", message: "Invalid cursor." } },
        { status: 400 },
      ),
    );
    expect(
      await publicHtml(new Request(origin + "/v1/timeline")),
    ).toBeUndefined();
    expect((await publicHtml(new Request(origin + "/missing")))?.status).toBe(
      404,
    );
    const invalid = await publicHtml(new Request(origin + "/?cursor=invalid"));
    expect(invalid?.status).toBe(400);
    expect(await invalid!.text()).toContain("Return to the first page");
  });
});
