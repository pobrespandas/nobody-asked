import {
  mkdtemp,
  rm,
  chmod,
  stat,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, validateOrigin } from "./client.js";
import { IdentityStore, type IdentityState } from "./state.js";
import { parse } from "./main.js";
import { redact } from "./errors.js";
import { validatePost } from "./commands.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function store(origin = "https://network.test") {
  const dir = await mkdtemp(join(tmpdir(), "nobody-cli-test-"));
  roots.push(dir);
  return new IdentityStore(origin, "test", dir);
}
function identity(origin: string): IdentityState {
  return {
    formatVersion: 1,
    origin,
    agentId: "agent",
    credential: "private-value",
    privateKey: "private-key",
    handle: "agent",
    displayName: "Agent",
    description: null,
  };
}
describe("CLI identity storage", () => {
  it("persists atomically with owner-only permissions and origin isolation", async () => {
    const state = await store();
    await state.locked(async () => {
      await state.write(identity(state.origin));
    });
    expect(await state.read()).toEqual(identity(state.origin));
    if (process.platform !== "win32") {
      expect((await stat(state.file)).mode & 0o777).toBe(0o600);
      expect((await stat(state.directory)).mode & 0o777).toBe(0o700);
    }
    const other = new IdentityStore(
      "https://other.test",
      "test",
      join(state.directory, "../.."),
    );
    expect(await other.read()).toBeNull();
  });
  it("refuses simultaneous writers and releases the lock after failure", async () => {
    const state = await store();
    await state.locked(async () => {
      await expect(state.locked(async () => 1)).rejects.toMatchObject({
        code: "state_locked",
      });
    });
    await expect(
      state.locked(async () => {
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    await expect(state.locked(async () => 1)).resolves.toBe(1);
  });
  it.skipIf(process.platform === "win32")(
    "rejects exposed permissions and symlink identity files",
    async () => {
      const state = await store();
      await state.locked(async () => {
        await state.write(identity(state.origin));
      });
      await chmod(state.file, 0o644);
      await expect(state.read()).rejects.toMatchObject({
        code: "unsafe_storage",
      });
      await rm(state.file);
      const target = join(state.directory, "other.json");
      await writeFile(target, "{}", { mode: 0o600 });
      await symlink(target, state.file);
      await expect(state.read()).rejects.toMatchObject({
        code: "unsafe_storage",
      });
    },
  );
  it("context construction and absent reads create no files", async () => {
    const state = await store();
    expect(await state.read()).toBeNull();
    await expect(stat(state.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
describe("CLI boundaries", () => {
  it.each([
    "http://public.test",
    "https://user:pass@network.test",
    "https://network.test/path",
    "https://network.test/?secret=x",
    "file:///tmp/x",
  ])("rejects unsafe origin %s", (input) => {
    expect(() => validateOrigin(input)).toThrow();
  });
  it("accepts HTTPS and loopback HTTP and keeps equals in input", () => {
    expect(validateOrigin("http://127.0.0.1:1234")).toBe(
      "http://127.0.0.1:1234",
    );
    expect(
      parse(["post", "x=y", "--idempotency-key=a=b", "--json"]),
    ).toMatchObject({
      args: ["x=y"],
      options: { "idempotency-key": ["a=b"] },
      json: true,
    });
  });
  it.each([
    ["post", "x", "--unknown", "y"],
    ["whoami", "--handle", "x"],
    ["reply", "one"],
    ["timeline", "--limit", "1", "--limit", "2"],
  ])("rejects invalid arguments %j", (...argv) => {
    expect(() => parse(argv)).toThrow();
  });
  it("counts visible graphemes instead of Unicode code units", () => {
    expect(() => validatePost("👨‍👩‍👧‍👦".repeat(128))).not.toThrow();
    expect(() => validatePost("👨‍👩‍👧‍👦".repeat(129))).toThrow();
    expect(() => validatePost(" ")).toThrow();
  });
  it("redacts one-time secrets recursively", () => {
    expect(
      redact({
        data: {
          credential: "secret",
          agentId: "agent",
          nested: [{ privateKey: "pem", signature: "sig" }],
        },
      }),
    ).toEqual({ data: { agentId: "agent", nested: [{}] } });
  });
});
describe("discovered HTTP client", () => {
  it("resolves the real OpenAPI parameter references before validating pagination", async () => {
    const contract = JSON.parse(
      await readFile("apps/api/openapi/v1.json", "utf8"),
    );
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1")
        return Response.json({ contract: { href: "/v1/openapi.json" } });
      if (url.pathname === "/v1/openapi.json") return Response.json(contract);
      return Response.json({ data: [], page: { nextCursor: null } });
    });
    const client = new ApiClient("https://network.test", transport);
    await client.discover();
    await expect(
      client.call("getPublicTimeline", {
        query: { limit: "20", cursor: "opaque" },
      }),
    ).resolves.toMatchObject({ page: { nextCursor: null } });
    await expect(
      client.call("getPublicTimeline", { query: { unknown: "x" } }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(client.operations.has("publishPost")).toBe(true);
    expect(client.operations.has("reviewReport")).toBe(false);
  });
  it("never follows a cross-origin contract or sends a Credential to it", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({ contract: { href: "https://evil.test/contract" } }),
    );
    await expect(
      new ApiClient("https://network.test", transport).discover(),
    ).rejects.toMatchObject({ code: "invalid_contract" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("preserves server recovery and idempotency in stable sanitized errors", async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: {
            code: "rate_limited",
            message: "private-value",
            recovery: { action: "wait_and_retry", automaticRetry: false },
            retryAt: "2030-01-01T00:00:00Z",
          },
        },
        { status: 429 },
      ),
    );
    try {
      await new ApiClient("https://network.test", transport).request(
        "POST",
        "/v1/posts",
        { text: "x" },
        "private-value",
        "logical-key",
      );
      throw new Error("Expected error");
    } catch (error) {
      expect(error).toMatchObject({
        code: "rate_limited",
        exitCode: 7,
        details: {
          idempotencyKey: "logical-key",
          recovery: { automaticRetry: false },
        },
      });
      expect(JSON.stringify(error)).not.toContain("private-value");
    }
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { "Idempotency-Key": "logical-key" },
    });
  });
  it("returns a retry key without leaking transport diagnostics after an uncertain write", async () => {
    const client = new ApiClient("https://network.test", async () => {
      throw new Error("private-value url headers");
    });
    await expect(
      client.request(
        "POST",
        "/v1/posts",
        { text: "x" },
        "private-value",
        "same-key",
      ),
    ).rejects.toMatchObject({
      code: "transport_error",
      details: { idempotencyKey: "same-key" },
    });
  });
});
