import { describe, expect, it } from "vitest";
import { actionInput, AdminError, project } from "./contracts.js";
import { readAdminConfig } from "./config.js";
import { document, detail } from "./render.js";
import { moderationAgentTransition } from "@nobody-asked/safety";
import { createHostedAdministration } from "./index.js";
import type { Firestore } from "firebase-admin/firestore";
import { createAdminHttp } from "./http.js";
import type { AdminHttpDependencies } from "./http.js";

const principal = {
  operatorId: "owner",
  sessionId: "session",
  authenticatedAt: new Date(),
  csrf: "csrf-token",
  deletionIntent: null,
};
describe("administration boundaries", () => {
  it("keeps rejected OAuth callback URLs out of subsequent referrers", async () => {
    const handler = createAdminHttp({
      firestore: {},
      auth: {
        complete: async () => {
          throw new AdminError(401, "authentication_failed");
        },
      },
      jobs: {},
      config: {},
      verifyTask: async () => {},
    } as unknown as AdminHttpDependencies);
    const response = (await handler(
      new Request("https://site/admin/auth/callback?code=rejected-proof"),
    ))!;
    expect(response.status).toBe(401);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain("rejected-proof");
  });
  it("uses a normal Google link after the deletion identity form", async () => {
    const handler = createAdminHttp({
      firestore: {
        collection: () => ({ doc: () => ({ set: async () => {} }) }),
      },
      auth: {
        authenticate: async () => principal,
        validateWrite: () => {},
        begin: async () =>
          new Response(null, {
            status: 303,
            headers: {
              location:
                "https://accounts.google.com/authorize?state=test&nonce=test",
              "set-cookie":
                "__session=oauth.test; Secure; HttpOnly; SameSite=Lax",
            },
          }),
      },
      jobs: { preview: async () => ({ impact: "a".repeat(64) }) },
      config: {},
      verifyTask: async () => {},
    } as unknown as AdminHttpDependencies);
    const response = (await handler(
      new Request("https://site/admin/deletion/identify", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "resource=agents&id=fixture&csrf=csrf-token",
      }),
    ))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toContain(
      "__session=oauth.test",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toContain(
      'href="https://accounts.google.com/authorize?state=test&amp;nonce=test"',
    );
  });
  it("keeps moderation restoration distinct from activity restoration", () => {
    const suspended = moderationAgentTransition("stopped", "suspend");
    expect(
      moderationAgentTransition(
        suspended.status,
        "restore",
        suspended.statusBeforeSuspension,
      ).status,
    ).toBe("stopped");
    expect(moderationAgentTransition("stopped", "restore").status).toBe(
      "stopped",
    );
    expect(moderationAgentTransition("active", "suspend").status).toBe(
      "suspended",
    );
  });
  it("rejects unknown action fields and missing reasons", () => {
    const input = {
      resource: "content",
      id: "post",
      action: "hide",
      version: "1.1",
      reason: "Spam",
      category: "spam",
      key: "key",
    };
    expect(actionInput(input).resource).toBe("content");
    expect(() => actionInput({ ...input, secret: "private" })).toThrow(
      AdminError,
    );
    expect(() => actionInput({ ...input, reason: " " })).toThrow(AdminError);
    expect(() => actionInput({ ...input, id: "a/b" })).toThrow(AdminError);
  });
  it("projects explicit fields instead of serializing documents", () => {
    const snapshot = {
      id: "credential",
      updateTime: { seconds: 1, nanoseconds: 2 },
      data: () => ({
        agentId: "agent",
        secretDigest: "never-output",
        recoveryKey: "never-output",
        revokedAt: null,
      }),
    };
    expect(
      JSON.stringify(project("credentials", snapshot as never)),
    ).not.toContain("never-output");
    expect(project("credentials", snapshot as never)).toEqual({
      id: "credential",
      version: "1.2",
      agentId: "agent",
      revokedAt: null,
    });
  });
  it("renders normal links and forms without executable HTML", () => {
    const html = document(
      "<script>alert(1)</script>",
      detail(principal, "agents", {
        id: "agent",
        version: "1.2",
        handle: "<bad>",
      }),
      principal,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick=");
    expect(html).toContain('method="post"');
    expect(html).toContain('name="csrf"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("/admin/deletion/preview");
  });
  it("is disabled until explicit configuration exists", async () => {
    expect(readAdminConfig({})).toBeNull();
    const handler = createHostedAdministration({} as Firestore, {});
    expect((await handler(new Request("https://site/admin")))?.status).toBe(
      503,
    );
    expect(
      (await handler(new Request("https://site/v1/admin/agents")))?.headers.get(
        "cache-control",
      ),
    ).toContain("no-store");
    expect(await handler(new Request("https://site/"))).toBeUndefined();
  });
  it("fails closed for incomplete queue configuration", () => {
    expect(() =>
      readAdminConfig({
        ADMIN_ENABLED: "true",
        ADMIN_ORIGIN: "https://site",
        ADMIN_TASK_QUEUE: "queue",
      }),
    ).toThrow();
  });
});
