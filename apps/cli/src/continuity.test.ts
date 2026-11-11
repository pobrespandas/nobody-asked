import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "./client.js";
import { execute, parse } from "./main.js";
import { IdentityStore } from "./state.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const condition = {
  in: "header",
  name: "If-Match",
  schema: { type: "string" },
};
function op(operationId: string, method: string, parameters: unknown[] = []) {
  return {
    operationId,
    tags: [method === "get" ? "Agent reads" : "Agent commands"],
    security: [{ agentCredential: [] }],
    parameters,
    ...(method === "get" || method === "delete" ? {} : { requestBody: {} }),
  };
}
const contract = {
  paths: {
    "/v1/me": { get: op("getAuthenticatedAgent", "get") },
    "/v1/me/profile": {
      get: op("getOwnAgentProfile", "get"),
      patch: op("updateOwnAgentProfile", "patch", [condition]),
    },
    "/v1/me/inbox": {
      get: op("getOwnInbox", "get", [
        { in: "query", name: "limit" },
        { in: "query", name: "cursor" },
      ]),
    },
    "/v1/me/inbox/seen": { post: op("markOwnInboxSeen", "post") },
    "/v1/me/memory": {
      get: op("listOwnMemory", "get", [
        { in: "query", name: "limit" },
        { in: "query", name: "cursor" },
      ]),
    },
    "/v1/me/memory/{key}": {
      get: op("getOwnMemory", "get"),
      put: op("putOwnMemory", "put", [
        condition,
        { in: "header", name: "If-None-Match" },
      ]),
      delete: op("deleteOwnMemory", "delete", [condition]),
    },
    "/v1/me/memory-export": { get: op("exportOwnMemory", "get") },
  },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nobody-continuity-cli-"));
  roots.push(root);
  const origin = "https://network.test",
    state = new IdentityStore(origin, "local", root);
  await state.locked(() =>
    state.write({
      formatVersion: 1,
      origin,
      agentId: "agent",
      credential: "credential.secret",
      privateKey: "private-key",
      handle: "agent",
      displayName: "Agent",
      description: null,
    }),
  );
  const requests: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/v1"))
        return Response.json({ contract: { href: "/v1/openapi.json" } });
      if (url.endsWith("/openapi.json")) return Response.json(contract);
      if (url.endsWith("/v1/me"))
        return Response.json({ data: { agent: { id: "agent" } } });
      return Response.json({
        data: { key: "working-context", version: "version-2" },
      });
    }),
  );
  return {
    root,
    requests,
    run: (args: string[]) =>
      execute(
        parse([
          "--base-url",
          origin,
          "--profile",
          "local",
          "--state-dir",
          root,
          ...args,
          "--json",
        ]),
      ),
  };
}
it("keeps command groups separate from the saved identity profile", () => {
  expect(parse(["--profile", "lina", "profile", "show"]).command).toBe(
    "profile show",
  );
  expect(
    parse(["memory", "put", "note", "--create", "--text-file", "-"]).options
      .create,
  ).toEqual(["true"]);
  expect(() => parse(["profile", "unknown"])).toThrow();
});
it("sends only declared conditional headers and never permits authentication injection", async () => {
  const calls: RequestInit[] = [];
  const client = new ApiClient("https://network.test", async (_input, init) => {
    calls.push(init ?? {});
    return Response.json({ data: {} });
  });
  client.operations.set("change", {
    method: "PATCH",
    path: "/v1/me/profile",
    authenticated: true,
    contract: { parameters: [condition], requestBody: {} },
  });
  await client.call("change", {
    credential: "credential.secret",
    body: { displayName: "New" },
    headers: { "If-Match": '"v1"' },
  });
  expect(calls[0]!.headers).toMatchObject({
    "if-match": '"v1"',
    Authorization: "Bearer credential.secret",
  });
  for (const headers of [
    { Authorization: "other" },
    { "If-None-Match": "*" },
    { "If-Match": "v1\r\nAuthorization: other" },
  ])
    await expect(
      client.call("change", { credential: "credential.secret", headers }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    client.request("PATCH", "/v1/me/profile", {}, "credential.secret", "key", {
      Authorization: "other",
    }),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(calls).toHaveLength(1);
});
it("reads private note text from a file and sends create-only proof with a stable key", async () => {
  const test = await fixture(),
    file = join(test.root, "note.txt");
  await writeFile(file, "Private note\nwith whitespace\n");
  await test.run([
    "memory",
    "put",
    "working-context",
    "--text-file",
    file,
    "--create",
    "--idempotency-key",
    "save-context",
  ]);
  const sent = test.requests.find((request) => request.init.method === "PUT")!;
  expect(sent.url).toBe("https://network.test/v1/me/memory/working-context");
  expect(sent.init.body).toBe(
    JSON.stringify({ text: "Private note\nwith whitespace\n" }),
  );
  expect(sent.init.headers).toMatchObject({
    "if-none-match": "*",
    "Idempotency-Key": "save-context",
  });
  await expect(
    test.run([
      "memory",
      "put",
      "working-context",
      "--text-file",
      file,
      "--create",
      "--if-match",
      "v1",
    ]),
  ).rejects.toMatchObject({ code: "invalid_input" });
});
it("keeps last-seen advancement explicit and profile clearing conditional", async () => {
  const test = await fixture();
  await test.run(["inbox", "list", "--limit", "25"]);
  expect(test.requests.some((request) => request.init.method === "POST")).toBe(
    false,
  );
  await test.run([
    "inbox",
    "seen",
    "--through",
    "signed-position",
    "--idempotency-key",
    "seen-page",
  ]);
  expect(
    test.requests.find((request) => request.url.endsWith("/seen"))!.init.body,
  ).toBe(JSON.stringify({ through: "signed-position" }));
  await test.run([
    "profile",
    "update",
    "--clear-description",
    "--if-match",
    "version-1",
  ]);
  const patch = test.requests.find(
    (request) => request.init.method === "PATCH",
  )!;
  expect(patch.init.body).toBe('{"description":null}');
  expect(patch.init.headers).toMatchObject({ "if-match": '"version-1"' });
});
it("supports conditional proof in the generic API command", async () => {
  const test = await fixture(),
    file = join(test.root, "profile.json");
  await writeFile(file, JSON.stringify({ displayName: "Lina" }));
  await test.run([
    "api",
    "updateOwnAgentProfile",
    "--data",
    `@${file}`,
    "--header",
    'If-Match="version-1"',
  ]);
  expect(
    test.requests.find((request) => request.init.method === "PATCH")!.init
      .headers,
  ).toMatchObject({ "if-match": '"version-1"' });
});
it("rejects ambiguous conditions and unadvertised private routing", async () => {
  const test = await fixture(),
    file = join(test.root, "note.txt");
  await writeFile(file, "context");
  await expect(
    test.run(["memory", "put", "working-context", "--text-file", file]),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    test.run([
      "memory",
      "put",
      "working-context",
      "--text-file",
      file,
      "--create",
      "--if-match",
      "v1",
    ]),
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    test.run([
      "api",
      "getOwnMemory",
      "--param",
      "key=working-context",
      "--header",
      "Authorization=other",
    ]),
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(
    test.requests.every(
      (request) =>
        new Headers(request.init.headers).get("authorization") !== "other",
    ),
  ).toBe(true);
});
it("does not read private continuity data when the Credential and saved identity disagree", async () => {
  const test = await fixture();
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = String(input);
    if (url.endsWith("/v1"))
      return Response.json({ contract: { href: "/v1/openapi.json" } });
    if (url.endsWith("/openapi.json")) return Response.json(contract);
    if (url.endsWith("/v1/me"))
      return Response.json({ data: { agent: { id: "other-agent" } } });
    throw Error("Private data must not be requested");
  });
  await expect(
    test.run(["memory", "get", "working-context"]),
  ).rejects.toMatchObject({ code: "identity_mismatch" });
});
