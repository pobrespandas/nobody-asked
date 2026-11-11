import {
  FirestoreAgentMemory,
  FirestorePublicReadRepository,
} from "@nobody-asked/persistence";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createLocalFirestoreAdmin,
  resetLocalFirestore,
  type LocalFirestoreAdmin,
} from "@nobody-asked/firestore-support";
import { bootstrapAdministrator } from "../../../../tools/bootstrap-administrator.js";
import { AdminAuth, type GoogleVerifier } from "./auth.js";
import { digest, version, type Principal } from "./contracts.js";
import { AdminQueries } from "./queries.js";
import { readConversation } from "./conversations.js";
import { AdminActions } from "./actions.js";
import { AdminJobs, type JobObjects, type LedgerEntry } from "./jobs.js";
import { createAdminHttp } from "./http.js";
import { administrationLogger, readSummary } from "./metrics.js";
import type { AdminConfig } from "./config.js";
import {
  reconcileDeletionLedger,
  assertRecoveryGate,
  activateRecoveryGate,
} from "./recovery.js";

const at = new Date("2026-11-07T12:00:00Z"),
  stamp = Timestamp.fromDate(at);
const config: AdminConfig = {
  origin: "https://nobodyasked.test",
  googleClientId: "test-client",
  googleClientSecret: "test-secret",
  projectId: "demo-nobody-asked",
  databaseId: "nobody-asked-dev",
  queue: null,
  taskUrl: null,
  taskServiceAccount: null,
  ledgerBucket: null,
};
const principal: Principal = {
  operatorId: "owner",
  sessionId: "session",
  authenticatedAt: at,
  csrf: "csrf-token",
  deletionIntent: null,
};
const google: GoogleVerifier = {
  authorization: (state, nonce) =>
    `https://accounts.google.com/authorize?state=${state}&nonce=${nonce}`,
  exchange: async () => ({
    issuer: "https://accounts.google.com",
    subject: "google-owner",
    email: "owner@example.test",
  }),
};
describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "private administration with Firestore",
  () => {
    let local: LocalFirestoreAdmin;
    let entries: Map<string, LedgerEntry>,
      artifacts: Map<string, unknown>,
      queued: string[];
    let objects: JobObjects, jobs: AdminJobs, auth: AdminAuth;
    beforeAll(() => {
      local = createLocalFirestoreAdmin({ appName: "administration-tests" });
    });
    afterAll(async () => {
      await deleteApp(local.app);
    });
    beforeEach(async () => {
      await resetLocalFirestore();
      const db = local.firestore;
      await db
        .collection("operators")
        .doc("owner")
        .set({ normalizedIdentity: "owner@example.test", createdAt: stamp });
      await bootstrapAdministrator(
        db,
        {
          operatorId: "owner",
          subject: "google-owner",
          verifiedEmail: "owner@example.test",
        },
        at,
      );
      await db
        .collection("operatorSessions")
        .doc("session")
        .set({
          operatorId: "owner",
          secretDigest: digest("session-secret"),
          origin: config.origin,
          authenticatedAt: stamp,
          expiresAt: Timestamp.fromMillis(at.getTime() + 43200000),
          revokedAt: null,
          adminCsrf: principal.csrf,
          adminGoogleBinding: digest(
            "https://accounts.google.com:google-owner",
          ),
          adminDeletionIntent: null,
        });
      entries = new Map();
      artifacts = new Map();
      queued = [];
      objects = {
        async writeLedger(entry) {
          entries.set(entry.id, entry);
        },
        async writeArtifact(id, value) {
          artifacts.set(id, value);
        },
        async readArtifact(id) {
          return artifacts.get(id);
        },
        async deleteArtifacts(prefix) {
          for (const id of artifacts.keys())
            if (id.startsWith(prefix)) artifacts.delete(id);
          return true;
        },
        async listLedger() {
          return { items: [...entries.values()], nextCursor: null };
        },
      };
      jobs = new AdminJobs(
        db,
        objects,
        {
          async enqueue(id) {
            queued.push(id);
          },
        },
        () => at,
      );
      auth = new AdminAuth(db, config, google, () => at);
    });
    const request = (path: string, init: RequestInit = {}) =>
      new Request(`${config.origin}${path}`, {
        ...init,
        headers: {
          cookie: "__session=session.session-secret",
          ...init.headers,
        },
      });
    async function seedAgent(id = "agent", status = "active") {
      await local.firestore
        .collection("agentProfiles")
        .doc(id)
        .set({
          handle: id,
          displayName: `Agent ${id}`,
          status,
          createdAt: stamp,
          updatedAt: stamp,
        });
      await local.firestore
        .collection("credentials")
        .doc(`credential-${id}`)
        .set({
          agentId: id,
          secretDigest: "never-disclose",
          createdAt: stamp,
          revokedAt: null,
        });
      await local.firestore
        .collection("agentAccess")
        .doc(id)
        .set({ activeCredentialId: `credential-${id}` });
    }
    async function seedPost(
      id: string,
      authorId: string,
      parentId: string | null = null,
    ) {
      await local.firestore
        .collection("publicItems")
        .doc(id)
        .set({
          id,
          type: parentId ? "reply" : "post",
          authorId,
          authorHandle: authorId,
          authorDisplayName: authorId,
          text: `Private source text ${id}`,
          parentId,
          conversationRootId: parentId ?? id,
          visibility: "visible",
          publishedAt: stamp,
        });
    }
    it("reads every branch beyond 100 messages with names, hidden items and parent context", async () => {
      await seedAgent("lina");
      await seedAgent("mateo");
      await local.firestore
        .doc("agentProfiles/lina")
        .update({ displayName: "Lina", privateValue: "never-show" });
      await local.firestore
        .doc("agentProfiles/mateo")
        .update({ displayName: "Mateo" });
      await seedPost("root", "lina");
      const batch = local.firestore.batch();
      for (let i = 0; i < 205; i++) {
        const id = `reply-${String(i).padStart(3, "0")}`;
        batch.create(local.firestore.doc(`publicItems/${id}`), {
          id,
          type: "reply",
          authorId: i % 2 ? "lina" : "mateo",
          text: i === 3 ? "" : `Message ${i}`,
          parentId:
            i === 0 || i === 100
              ? "root"
              : `reply-${String(i - 1).padStart(3, "0")}`,
          conversationRootId: "root",
          publishedAt: Timestamp.fromMillis(at.getTime() + 1000),
          visibility: i === 2 ? "hidden" : i === 3 ? "deleted" : "visible",
          ...(i === 3 ? { deletedAt: stamp } : {}),
        });
      }
      await batch.commit();
      let cursor: string | null = null;
      const ids: string[] = [];
      let pages = 0;
      do {
        const params = new URLSearchParams({
          limit: "37",
          ...(cursor ? { cursor } : {}),
        });
        const page = await readConversation(
          local.firestore,
          pages === 0 ? "reply-100" : "root",
          params,
        );
        expect(page.root?.id).toBe("root");
        expect(page.authors.map((author) => author.displayName).sort()).toEqual(
          ["Lina", "Mateo"],
        );
        expect(JSON.stringify(page)).not.toContain("never-show");
        if (pages) expect(page.parents.length).toBeGreaterThan(0);
        ids.push(...page.items.map((row) => row.id));
        cursor = page.page.nextCursor;
        pages++;
        expect(pages).toBeLessThan(10);
      } while (cursor);
      expect(ids).toEqual([
        "root",
        ...Array.from(
          { length: 205 },
          (_, i) => `reply-${String(i).padStart(3, "0")}`,
        ),
      ]);
      expect(new Set(ids).size).toBe(206);
      const first = await readConversation(
        local.firestore,
        "root",
        new URLSearchParams(),
      );
      expect(
        first.items.find((row) => row.id === "reply-002")?.visibility,
      ).toBe("hidden");
      expect(first.items.find((row) => row.id === "reply-003")?.text).toBe("");
      await local.firestore
        .doc("publicItems/repost")
        .set({ type: "repost", sourcePostId: "reply-100", authorId: "lina" });
      expect(
        (
          await readConversation(
            local.firestore,
            "repost",
            new URLSearchParams(),
          )
        ).rootId,
      ).toBe("root");
      const http = createAdminHttp({
        firestore: local.firestore,
        auth,
        jobs,
        config,
        verifyTask: async () => {},
        now: () => at,
      });
      const response = (await http(
        request("/v1/admin/conversations/repost?limit=100"),
      ))!;
      expect(response.status).toBe(200);
      expect((await response.json()).data.items).toHaveLength(100);
      const html = await (await http(
        request("/admin/conversations/reply-100?limit=2"),
      ))!.text();
      expect(html).toContain("Lina");
      expect(html).toContain("Mateo");
      expect(html).toContain("Continue conversation");
      const listHtml = await (await http(
        request("/admin/content?id=root"),
      ))!.text();
      expect(listHtml).toContain("Lina");
      expect(listHtml).toContain("Private source text root");
      expect(listHtml).toContain("Read conversation");
      await expect(
        readConversation(
          local.firestore,
          "root",
          new URLSearchParams({ cursor: "invalid" }),
        ),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
      await expect(
        readConversation(
          local.firestore,
          "root",
          new URLSearchParams({ limit: "101" }),
        ),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await seedPost("another-root", "lina");
      await expect(
        readConversation(
          local.firestore,
          "another-root",
          new URLSearchParams({ cursor: first.page.nextCursor! }),
        ),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
    });
    async function command(
      kind: "agents" | "content" | "reports",
      id: string,
      action: string,
    ) {
      const snapshot = await local.firestore
        .collection(
          kind === "agents"
            ? "agentProfiles"
            : kind === "reports"
              ? "reports"
              : "publicItems",
        )
        .doc(id)
        .get();
      const subject = kind === "reports" ? snapshot.data()?.target : null;
      const subjectSnapshot = subject
        ? await local.firestore
            .collection(
              subject.type === "agent_profile"
                ? "agentProfiles"
                : "publicItems",
            )
            .doc(subject.id)
            .get()
        : null;
      return {
        ...(subjectSnapshot
          ? { subjectVersion: version(subjectSnapshot) }
          : {}),
        resource: kind,
        id,
        action,
        version: version(snapshot),
        reason: "Review found spam",
        category: "spam",
        key: randomUUID(),
      };
    }
    it("bootstraps once and rejects another subject or operator email", async () => {
      await expect(
        bootstrapAdministrator(
          local.firestore,
          {
            operatorId: "owner",
            subject: "other",
            verifiedEmail: "owner@example.test",
          },
          at,
        ),
      ).rejects.toMatchObject({ code: "administrator_already_bootstrapped" });
      await expect(
        bootstrapAdministrator(
          local.firestore,
          {
            operatorId: "owner",
            subject: "google-owner",
            verifiedEmail: "wrong@example.test",
          },
          at,
        ),
      ).rejects.toMatchObject({ code: "operator_identity_mismatch" });
      expect(
        (await local.firestore.collection("administratorAuthorities").get())
          .size,
      ).toBe(1);
    });
    it("checks Google-bound authority and rejects ordinary Operator sessions", async () => {
      expect((await auth.authenticate(request("/admin"))).operatorId).toBe(
        "owner",
      );
      await local.firestore
        .collection("operatorSessions")
        .doc("session")
        .update({ adminGoogleBinding: null });
      await expect(auth.authenticate(request("/admin"))).rejects.toMatchObject({
        status: 401,
      });
    });
    it("consumes OAuth state once and binds it to this browser", async () => {
      const start = await auth.begin(
        new Request(`${config.origin}/admin/auth/start`),
      );
      const location = new URL(start.headers.get("location")!);
      const state = location.searchParams.get("state")!;
      const browserCookie = start.headers.get("set-cookie")!.split(";")[0]!;
      const callback = (cookie: string) =>
        new Request(
          `${config.origin}/admin/auth/callback?state=${state}&code=valid-code`,
          { headers: { cookie } },
        );
      await expect(
        auth.complete(callback("__session=oauth.wrong")),
      ).rejects.toMatchObject({ code: "authentication_failed" });
      const handle = createAdminHttp({
        firestore: local.firestore,
        auth,
        jobs,
        config,
        verifyTask: async () => {},
        now: () => at,
      });
      const result = (await handle(callback(browserCookie)))!;
      expect(result.status).toBe(200);
      expect(result.headers.get("set-cookie")).toContain("HttpOnly");
      expect(result.headers.get("set-cookie")).toContain("SameSite=Strict");
      expect(result.headers.get("location")).toBeNull();
      expect(result.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await result.text()).toContain(
        'href="/admin">Continue to administration</a>',
      );
      await expect(
        auth.complete(callback(browserCookie)),
      ).rejects.toMatchObject({ code: "authentication_failed" });
    });
    it("rejects origin, CSRF and stale authentication", () => {
      expect(() =>
        auth.validateWrite(
          request("/admin/action", {
            method: "POST",
            headers: { origin: "https://evil.test" },
          }),
          principal,
          principal.csrf,
        ),
      ).toThrow();
      expect(() =>
        auth.validateWrite(
          request("/admin/action", {
            method: "POST",
            headers: { origin: config.origin },
          }),
          principal,
          "wrong",
        ),
      ).toThrow();
      expect(() =>
        auth.validateWrite(
          request("/admin/action", {
            method: "POST",
            headers: { origin: config.origin },
          }),
          { ...principal, authenticatedAt: new Date(at.getTime() - 600000) },
          principal.csrf,
        ),
      ).toThrow();
    });
    it("paginates private projections without exposing secrets and binds filters", async () => {
      await seedAgent("a");
      await seedAgent("b");
      await seedAgent("c", "stopped");
      const queries = new AdminQueries(local.firestore),
        params = new URLSearchParams({ status: "active", limit: "1" });
      const first = await queries.list("agents", params);
      expect(first.items.map((row) => row.id)).toEqual(["a"]);
      params.set("cursor", first.page.nextCursor!);
      expect(
        (await queries.list("agents", params)).items.map((row) => row.id),
      ).toEqual(["b"]);
      for (const value of ["null", "[]", "{}", "42"])
        await expect(
          queries.list(
            "agents",
            new URLSearchParams({
              cursor: Buffer.from(value).toString("base64url"),
            }),
          ),
        ).rejects.toMatchObject({ code: "invalid_cursor" });
      params.set("status", "stopped");
      await expect(queries.list("agents", params)).rejects.toMatchObject({
        code: "invalid_cursor",
      });
      expect(
        JSON.stringify(
          await queries.list("credentials", new URLSearchParams()),
        ),
      ).not.toContain("never-disclose");
    });
    it("allows only one concurrent change and records action and state together", async () => {
      await seedAgent("agent", "stopped");
      const actions = new AdminActions(local.firestore, () => at),
        input = await command("agents", "agent", "suspend");
      const results = await Promise.allSettled([
        actions.execute(principal, input),
        actions.execute(principal, { ...input, key: "second" }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (
          await local.firestore
            .collection("credentials")
            .doc("credential-agent")
            .get()
        ).data()?.revokedAt,
      ).toEqual(stamp);
      const conflict = results.find((result) => result.status === "rejected");
      expect(
        conflict?.status === "rejected" ? conflict.reason : null,
      ).toMatchObject({ code: "record_conflict" });
      await actions.execute(
        principal,
        await command("agents", "agent", "restore"),
      );
      expect(
        (
          await local.firestore.collection("agentProfiles").doc("agent").get()
        ).data()?.status,
      ).toBe("stopped");
    }, 20_000);
    it("checks session revocation inside the action transaction", async () => {
      await seedAgent();
      await local.firestore
        .collection("operatorSessions")
        .doc("session")
        .update({ revokedAt: stamp });
      await expect(
        new AdminActions(local.firestore, () => at).execute(
          principal,
          await command("agents", "agent", "suspend"),
        ),
      ).rejects.toMatchObject({ code: "administrator_required" });
      expect(
        (
          await local.firestore.collection("agentProfiles").doc("agent").get()
        ).data()?.status,
      ).toBe("active");
    });
    it("resolves a report with moderation and audit in one transaction", async () => {
      await seedAgent();
      await seedPost("post", "agent");
      await local.firestore
        .collection("reports")
        .doc("report")
        .set({
          target: { type: "public_item", id: "post" },
          resolvedAt: null,
          reasonCategory: "spam",
          reportedAt: stamp,
        });
      await new AdminActions(local.firestore, () => at).execute(
        principal,
        await command("reports", "report", "resolve"),
      );
      expect(
        (await local.firestore.collection("reports").doc("report").get()).data()
          ?.decision,
      ).toBe("content_hidden");
      expect(
        (
          await local.firestore.collection("publicItems").doc("post").get()
        ).data()?.visibility,
      ).toBe("hidden");
    });
    it("requires target-bound identity confirmation and preserves other Agents' replies", async () => {
      await seedAgent();
      await seedAgent("other");
      await seedPost("root", "agent");
      await seedPost("reply", "other", "root");
      const preview = await jobs.preview("agents", "agent");
      const input = {
        ...(await command("agents", "agent", "delete")),
        confirmation: "agent",
        impact: preview.impact,
      };
      await expect(jobs.createDeletion(principal, input)).rejects.toMatchObject(
        { code: "deletion_confirmation_required" },
      );
      await local.firestore
        .collection("operatorSessions")
        .doc("session")
        .update({ adminDeletionIntent: preview.impact });
      const result = await jobs.createDeletion(
        { ...principal, deletionIntent: preview.impact },
        input,
      );
      expect(
        (
          await local.firestore.collection("agentProfiles").doc("agent").get()
        ).data()?.status,
      ).toBe("suspended");
      for (let i = 0; i < 20; i++) {
        await jobs.step(result.id);
        if (
          (
            await local.firestore.collection("adminJobs").doc(result.id).get()
          ).data()?.status === "completed"
        )
          break;
      }
      expect(entries.size).toBe(1);
      const publicReads = new FirestorePublicReadRepository(local.firestore);
      expect((await publicReads.findVisiblePublicPostById("root"))?.text).toBe(
        "[Deleted post]",
      );
      expect(
        (await publicReads.listVisibleConversation("root")).map(
          (post) => post.id,
        ),
      ).toContain("reply");
      expect(
        (
          await local.firestore.collection("publicItems").doc("root").get()
        ).data()?.text,
      ).toBe("");
      expect(
        (
          await local.firestore.collection("publicItems").doc("reply").get()
        ).data()?.text,
      ).toBe("Private source text reply");
      expect(
        (
          await local.firestore
            .collection("credentials")
            .where("agentId", "==", "agent")
            .get()
        ).empty,
      ).toBe(true);
      expect(
        (
          await local.firestore.collection("agentProfiles").doc("agent").get()
        ).data()?.deletedAt,
      ).toBeTruthy();
      await jobs.step(result.id);
      expect(entries.size).toBe(1);
    });
    it("fails before deleting content when the independent ledger is unavailable", async () => {
      await seedAgent();
      await seedPost("root", "agent");
      const preview = await jobs.preview("content", "root");
      await local.firestore
        .collection("operatorSessions")
        .doc("session")
        .update({ adminDeletionIntent: preview.impact });
      const result = await jobs.createDeletion(
        { ...principal, deletionIntent: preview.impact },
        {
          ...(await command("content", "root", "delete")),
          confirmation: "root",
          impact: preview.impact,
        },
      );
      const failed = new AdminJobs(
        local.firestore,
        {
          ...objects,
          async writeLedger() {
            throw new Error("offline");
          },
        },
        { async enqueue() {} },
        () => at,
      );
      await expect(failed.step(result.id)).rejects.toThrow("offline");
      expect(
        (
          await local.firestore.collection("publicItems").doc("root").get()
        ).data()?.text,
      ).toBe("Private source text root");
      await jobs.step(result.id);
      await jobs.step(result.id);
      expect(
        (
          await local.firestore.collection("adminJobs").doc(result.id).get()
        ).data()?.status,
      ).toBe("completed");
    });
    it("exports private-safe chunks and blocks artifact access after deletion starts", async () => {
      await seedAgent();
      await seedPost("root", "agent");
      const job = await jobs.createExport(
        principal,
        "agent",
        "Owner requested export",
      );
      await jobs.step(job.id);
      const data = await jobs.download(job.id, 0);
      expect(JSON.stringify(data)).toContain("Private source text root");
      expect(JSON.stringify(data)).not.toContain("never-disclose");
      await local.firestore
        .collection("agentProfiles")
        .doc("agent")
        .update({ deletingAt: stamp });
      await expect(jobs.download(job.id, 0)).rejects.toMatchObject({
        code: "artifact_unavailable",
      });
    });
    it("serves protected HTML and JSON with the same state and private cache headers", async () => {
      await seedAgent();
      const http = createAdminHttp({
        firestore: local.firestore,
        auth,
        jobs,
        config,
        verifyTask: async () => {
          throw new Error("untrusted");
        },
        now: () => at,
      });
      const anonymous = await http(
        new Request(`${config.origin}/v1/admin/agents`),
      );
      expect(anonymous?.status).toBe(401);
      const response = await http(request("/admin/agents"));
      expect(response?.status).toBe(200);
      expect(response?.headers.get("referrer-policy")).toBe("same-origin");
      expect(response?.headers.get("cache-control")).toContain("no-store");
      const source = await response!.text();
      expect(source).not.toContain("<script");
      expect(source).toContain('method="get"');
      expect(source).toContain("Agent agent");
      const input = {
        ...(await command("agents", "agent", "suspend")),
        csrf: principal.csrf,
      };
      const changed = await http(
        request("/v1/admin/action", {
          method: "POST",
          headers: {
            origin: config.origin,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        }),
      );
      expect(changed?.status).toBe(200);
      expect(
        (
          await local.firestore.collection("agentProfiles").doc("agent").get()
        ).data()?.status,
      ).toBe("suspended");
    });

    it("denies every private read to visitors, Agents, ordinary Operators and revoked authorities", async () => {
      await seedAgent();
      const http = createAdminHttp({
        firestore: local.firestore,
        auth,
        jobs,
        config,
        verifyTask: async () => {
          throw new Error("untrusted");
        },
        now: () => at,
      });
      await local.firestore
        .collection("operatorSessions")
        .doc("ordinary")
        .set({
          operatorId: "owner",
          secretDigest: digest("ordinary-secret"),
          origin: config.origin,
          authenticatedAt: stamp,
          expiresAt: Timestamp.fromMillis(at.getTime() + 43200000),
          revokedAt: null,
        });
      const paths = [
        "",
        "/openapi.json",
        "/agents",
        "/content",
        "/reports",
        "/operators",
        "/authorizations",
        "/invitations",
        "/sessions",
        "/credentials",
        "/audit",
        "/jobs",
        "/audit/export",
        "/jobs/unknown/artifact?part=0",
        "/conversations/unknown",
      ];
      const denied = async (
        headers: Record<string, string>,
        status: number,
      ) => {
        for (const path of paths) {
          const response = (await http(
            new Request(`${config.origin}/v1/admin${path}`, { headers }),
          ))!;
          expect(response.status, path).toBe(status);
          expect(response.headers.get("cache-control")).toBe(
            "private, no-store",
          );
          expect(response.headers.get("x-robots-tag")).toBe(
            "noindex, nofollow",
          );
          expect(await response.text()).not.toContain("never-disclose");
        }
      };
      await denied({}, 401);
      await denied({ authorization: "Bearer synthetic-agent-credential" }, 401);
      await denied({ cookie: "__session=ordinary.ordinary-secret" }, 401);
      await local.firestore
        .collection("administratorAuthorities")
        .doc("owner")
        .update({ revokedAt: stamp });
      await denied({ cookie: "__session=session.session-secret" }, 403);
      expect(
        (
          await local.firestore.collection("agentProfiles").doc("agent").get()
        ).data()?.status,
      ).toBe("active");
    }, 30000);
    it("rejects unsafe and stale form submissions without partial writes or audit records", async () => {
      await seedAgent();
      const http = createAdminHttp({
        firestore: local.firestore,
        auth,
        jobs,
        config,
        verifyTask: async () => {},
        now: () => at,
      });
      const input = {
        ...(await command("agents", "agent", "suspend")),
        csrf: principal.csrf,
      };
      const auditBefore = (
        await local.firestore.collection("auditRecords").get()
      ).size;
      const submit = async (origin: string, values: Record<string, unknown>) =>
        http(
          request("/admin/action", {
            method: "POST",
            headers: {
              origin,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(
              Object.entries(values).map(([key, value]) => [
                key,
                String(value),
              ]),
            ).toString(),
          }),
        );
      expect((await submit("https://foreign.test", input))?.status).toBe(403);
      expect(
        (await submit(config.origin, { ...input, csrf: "wrong" }))?.status,
      ).toBe(403);
      expect(
        (await submit(config.origin, { ...input, reason: " " }))?.status,
      ).toBe(400);
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(auditBefore);
      expect(
        (
          await local.firestore.collection("agentProfiles").doc("agent").get()
        ).data()?.status,
      ).toBe("active");
      expect((await submit(config.origin, input))?.status).toBe(303);
      const auditAfter = (
        await local.firestore.collection("auditRecords").get()
      ).size;
      expect(auditAfter).toBe(auditBefore + 1);
      expect(
        (await submit(config.origin, { ...input, key: randomUUID() }))?.status,
      ).toBe(409);
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(auditAfter);
      expect(
        (
          await local.firestore.collection("agentProfiles").doc("agent").get()
        ).data()?.status,
      ).toBe("suspended");
    });
    it("reconciles private note deletions and clears all private Agent state without disclosing text", async () => {
      await seedAgent();
      const caller = {
        agentId: "agent",
        credentialId: "credential-agent",
        token: "credential-agent.secret",
        at,
      };
      const memory = new FirestoreAgentMemory(
        local.firestore,
        () => "never-disclose",
        { writeDeletion: (entry) => objects.writeLedger(entry) },
      );
      const first = await memory.put(
        caller,
        "context",
        "private-memory-token",
        { createOnly: true },
        "create-private",
      );
      const original = await local.firestore
        .collection("agentMemoryNotes")
        .get();
      const restoredNote = original.docs[0]!.data(),
        noteId = original.docs[0]!.id;
      await memory.delete(
        caller,
        "context",
        first.metadata.version,
        "delete-private",
      );
      const captured = [...entries.values()];
      expect(captured).toHaveLength(1);
      expect(captured[0]!.targetType).toBe("memory");
      expect(JSON.stringify(captured)).not.toContain("private-memory-token");
      await local.firestore
        .collection("agentMemoryNotes")
        .doc(noteId)
        .set(restoredNote);
      const reconciled = await reconcileDeletionLedger(
        local.firestore,
        objects,
        () => at,
      );
      expect(reconciled.applied).toBe(1);
      expect(
        (await local.firestore.collection("agentMemoryNotes").doc(noteId).get())
          .exists,
      ).toBe(false);
      await memory.put(
        caller,
        "context",
        "new-incarnation-token",
        { createOnly: true },
        "create-new-private",
      );
      await reconcileDeletionLedger(local.firestore, objects, () => at);
      expect((await memory.get(caller, "context")).text).toBe(
        "new-incarnation-token",
      );
      await local.firestore
        .collection("agentInboxStates")
        .doc("agent")
        .set({ agentId: "agent", signingKey: "private-signing-material" });
      await local.firestore
        .collection("agentInboxEvents")
        .doc("event")
        .set({ recipientId: "agent", sequence: 1 });
      await local.firestore
        .collection("agentInboxCommands")
        .doc("command")
        .set({ agentId: "agent" });
      const preview = await jobs.preview("agents", "agent");
      await local.firestore
        .collection("operatorSessions")
        .doc("session")
        .update({ adminDeletionIntent: preview.impact });
      const job = await jobs.createDeletion(
        { ...principal, deletionIntent: preview.impact },
        {
          resource: "agents",
          id: "agent",
          action: "delete",
          version: preview.version,
          reason: "Remove isolated private data fixture",
          category: "abuse",
          key: "private-delete-agent",
          impact: preview.impact,
          confirmation: "agent",
        },
      );
      for (let step = 0; step < 100; step++) {
        await jobs.step(job.id);
        if (
          (
            await local.firestore.collection("adminJobs").doc(job.id).get()
          ).data()?.status === "completed"
        )
          break;
      }
      expect(
        (await local.firestore.collection("adminJobs").doc(job.id).get()).data()
          ?.status,
      ).toBe("completed");
      for (const collection of [
        "agentMemoryNotes",
        "agentMemoryStates",
        "agentMemoryCommands",
        "agentMemoryTombstones",
        "agentInboxStates",
        "agentInboxEvents",
        "agentInboxCommands",
      ]) {
        expect((await local.firestore.collection(collection).get()).empty).toBe(
          true,
        );
      }
      expect(JSON.stringify([...entries.values()])).not.toContain(
        "new-incarnation-token",
      );
      expect(
        JSON.stringify(
          (await local.firestore.collection("auditRecords").get()).docs.map(
            (doc) => doc.data(),
          ),
        ),
      ).not.toContain("private-memory-token");
    }, 30000);

    it("reconciles restored data and keeps the recovery gate closed on ledger failure", async () => {
      await seedAgent();
      await seedPost("root", "agent");
      await seedPost("reply", "other", "root");
      entries.set("accepted", {
        id: "accepted",
        targetType: "agents",
        targetId: "agent",
        requestedAt: at.toISOString(),
      });
      await expect(
        reconcileDeletionLedger(
          local.firestore,
          {
            ...objects,
            async listLedger() {
              throw new Error("unavailable");
            },
          },
          () => at,
        ),
      ).rejects.toThrow("unavailable");
      await expect(
        assertRecoveryGate(local.firestore, at),
      ).rejects.toMatchObject({ code: "deletion_recovery_not_verified" });
      const result = await reconcileDeletionLedger(
        local.firestore,
        objects,
        () => at,
      );
      expect(result.applied).toBe(1);
      await assertRecoveryGate(local.firestore, at, result.recoveryId);
      await expect(
        assertRecoveryGate(
          local.firestore,
          new Date(at.getTime() + 700000),
          result.recoveryId,
        ),
      ).rejects.toMatchObject({ code: "deletion_recovery_not_verified" });
      await activateRecoveryGate(local.firestore, result.recoveryId, at);
      await assertRecoveryGate(
        local.firestore,
        new Date(at.getTime() + 86400000),
        result.recoveryId,
      );
      await expect(
        assertRecoveryGate(local.firestore, at, "wrong-recovery"),
      ).rejects.toMatchObject({ code: "deletion_recovery_not_verified" });
      expect(
        (
          await local.firestore.collection("publicItems").doc("root").get()
        ).data()?.text,
      ).toBe("");
      expect(
        (
          await local.firestore.collection("publicItems").doc("reply").get()
        ).data()?.text,
      ).toContain("reply");
    });
    it("deletes multiple chunks without gaps and replays one request", async () => {
      await seedAgent();
      const batch = local.firestore.batch();
      for (let index = 0; index < 205; index++) {
        const id = `post-${String(index).padStart(4, "0")}`;
        batch.set(local.firestore.collection("publicItems").doc(id), {
          id,
          type: "post",
          authorId: "agent",
          text: "Remove this text",
          parentId: null,
          conversationRootId: id,
          visibility: "visible",
          publishedAt: stamp,
        });
      }
      await batch.commit();
      const preview = await jobs.preview("agents", "agent");
      await local.firestore
        .collection("operatorSessions")
        .doc("session")
        .update({ adminDeletionIntent: preview.impact });
      const input = {
        ...(await command("agents", "agent", "delete")),
        confirmation: "agent",
        impact: preview.impact,
      };
      const actor = { ...principal, deletionIntent: preview.impact };
      const result = await jobs.createDeletion(actor, input);
      expect((await jobs.createDeletion(principal, input)).id).toBe(result.id);
      for (let step = 0; step < 25; step++) {
        await jobs.step(result.id);
        if (
          (
            await local.firestore.collection("adminJobs").doc(result.id).get()
          ).data()?.status === "completed"
        )
          break;
      }
      const posts = await local.firestore
        .collection("publicItems")
        .where("authorId", "==", "agent")
        .get();
      expect(posts.size).toBe(205);
      expect(
        posts.docs.every(
          (doc) => doc.data().text === "" && doc.data().deletedAt,
        ),
      ).toBe(true);
      expect(
        (
          await local.firestore.collection("adminJobs").doc(result.id).get()
        ).data()?.status,
      ).toBe("completed");
    });
    it("rejects a changed Report subject without resolving the Report", async () => {
      await seedAgent();
      await seedPost("post", "agent");
      await local.firestore
        .collection("reports")
        .doc("report")
        .set({
          target: { type: "public_item", id: "post" },
          resolvedAt: null,
          reasonCategory: "spam",
          reportedAt: stamp,
        });
      const input = await command("reports", "report", "resolve");
      await local.firestore
        .collection("publicItems")
        .doc("post")
        .update({ visibility: "hidden" });
      await expect(
        new AdminActions(local.firestore, () => at).execute(principal, input),
      ).rejects.toMatchObject({ code: "record_conflict" });
      expect(
        (await local.firestore.collection("reports").doc("report").get()).data()
          ?.resolvedAt,
      ).toBeNull();
    });
    it("permits sign-out after the recent-authentication window", async () => {
      const later = new Date(at.getTime() + 700000);
      const olderAuth = new AdminAuth(
        local.firestore,
        config,
        google,
        () => later,
      );
      const http = createAdminHttp({
        firestore: local.firestore,
        auth: olderAuth,
        jobs,
        config,
        verifyTask: async () => {},
        now: () => later,
      });
      const response = await http(
        request("/admin/logout", {
          method: "POST",
          headers: {
            origin: config.origin,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ csrf: principal.csrf }).toString(),
        }),
      );
      expect(response?.status).toBe(303);
      expect(
        (
          await local.firestore
            .collection("operatorSessions")
            .doc("session")
            .get()
        ).data()?.revokedAt,
      ).toBeTruthy();
    });
    it("keeps isolated recovery from deleting production artifacts and invalidates restored exports", async () => {
      await seedAgent();
      await seedPost("root", "agent");
      const exported = await jobs.createExport(
        principal,
        "agent",
        "Verify restored export invalidation",
      );
      await jobs.step(exported.id);
      expect(artifacts.size).toBe(1);
      entries.set("content-deletion", {
        id: "content-deletion",
        targetType: "content",
        targetId: "root",
        requestedAt: at.toISOString(),
      });
      await reconcileDeletionLedger(local.firestore, objects, () => at);
      expect(artifacts.size).toBe(1);
      await expect(jobs.download(exported.id, 0)).rejects.toMatchObject({
        code: "artifact_unavailable",
      });
    });
    it("resumes an interrupted deletion and reconciles an older isolated database from a disk ledger", async () => {
      const ledgerDirectory = await mkdtemp(
        join(tmpdir(), "nobody-deletion-ledger-"),
      );
      const restored = getFirestore(local.app, `restore-${randomUUID()}`);
      const diskObjects = (): JobObjects => ({
        ...objects,
        async writeLedger(entry) {
          const path = join(ledgerDirectory, `${entry.id}.json`);
          const value = JSON.stringify(entry);
          try {
            await writeFile(path, value, { flag: "wx", mode: 0o600 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            expect(await readFile(path, "utf8")).toBe(value);
          }
        },
        async listLedger() {
          const files = (await readdir(ledgerDirectory)).sort();
          return {
            items: await Promise.all(
              files.map(
                async (file) =>
                  JSON.parse(
                    await readFile(join(ledgerDirectory, file), "utf8"),
                  ) as LedgerEntry,
              ),
            ),
            nextCursor: null,
          };
        },
      });
      try {
        await seedAgent();
        await seedAgent("other");
        const batch = local.firestore.batch();
        for (let index = 0; index < 205; index++) {
          const id = `drill-${String(index).padStart(4, "0")}`;
          batch.set(local.firestore.collection("publicItems").doc(id), {
            id,
            type: "post",
            authorId: "agent",
            text: "Disposable drill text",
            parentId: null,
            conversationRootId: id,
            visibility: "visible",
            publishedAt: stamp,
          });
        }
        await batch.commit();
        await seedPost("foreign-reply", "other", "drill-0000");
        // Capture only synthetic fixtures before deletion in another emulator database.
        for (const collection of [
          "agentProfiles",
          "agentAccess",
          "credentials",
          "publicItems",
        ]) {
          const snapshot = await local.firestore.collection(collection).get();
          const copy = restored.batch();
          for (const doc of snapshot.docs)
            copy.set(restored.doc(doc.ref.path), doc.data());
          await copy.commit();
        }
        const preview = await jobs.preview("agents", "agent");
        await local.firestore
          .collection("operatorSessions")
          .doc("session")
          .update({ adminDeletionIntent: preview.impact });
        const input = {
          ...(await command("agents", "agent", "delete")),
          confirmation: "agent",
          impact: preview.impact,
        };
        const actor = { ...principal, deletionIntent: preview.impact };
        const initial = new AdminJobs(
          local.firestore,
          diskObjects(),
          { async enqueue() {} },
          () => at,
        );
        const result = await initial.createDeletion(actor, input);
        expect((await initial.createDeletion(actor, input)).id).toBe(result.id);
        const interrupted = new AdminJobs(
          local.firestore,
          diskObjects(),
          {
            async enqueue() {
              throw new Error("Injected dispatch outage after commit");
            },
          },
          () => at,
        );
        await expect(interrupted.step(result.id)).rejects.toThrow(
          "Injected dispatch outage",
        );
        const checkpoint = (
          await local.firestore.collection("adminJobs").doc(result.id).get()
        ).data()!;
        expect(checkpoint.status).toBe("failed");
        expect(checkpoint.processed).toBe(100);
        const restarted = new AdminJobs(
          local.firestore,
          diskObjects(),
          { async enqueue() {} },
          () => at,
        );
        for (let step = 0; step < 30; step++) {
          await restarted.step(result.id);
          if (
            (
              await local.firestore.collection("adminJobs").doc(result.id).get()
            ).data()?.status === "completed"
          )
            break;
        }
        const completed = (
          await local.firestore.collection("adminJobs").doc(result.id).get()
        ).data()!;
        expect(completed.status).toBe("completed");
        await restarted.step(result.id);
        expect(
          (
            await local.firestore.collection("adminJobs").doc(result.id).get()
          ).data(),
        ).toEqual(completed);
        expect((await readdir(ledgerDirectory)).length).toBe(1);
        const ledgerText = await readFile(
          join(ledgerDirectory, `${result.id}.json`),
          "utf8",
        );
        expect(ledgerText).not.toContain("Disposable drill text");
        expect(ledgerText).not.toContain("never-disclose");
        const removed = await local.firestore
          .collection("publicItems")
          .where("authorId", "==", "agent")
          .get();
        expect(removed.size).toBe(205);
        expect(
          removed.docs.every(
            (doc) =>
              doc.data().text === "" && doc.data().visibility === "deleted",
          ),
        ).toBe(true);
        expect(
          (
            await local.firestore
              .collection("credentials")
              .doc("credential-agent")
              .get()
          ).exists,
        ).toBe(false);
        expect(
          (
            await restored.collection("publicItems").doc("drill-0000").get()
          ).data()?.text,
        ).toBe("Disposable drill text");
        const recoveryObjects: JobObjects = {
          ...diskObjects(),
          async writeLedger() {
            throw new Error("Recovery must not change the independent ledger");
          },
          async deleteArtifacts() {
            throw new Error("Recovery must not remove source artifacts");
          },
        };
        await expect(
          reconcileDeletionLedger(
            restored,
            {
              ...recoveryObjects,
              async listLedger() {
                throw new Error("Injected ledger outage");
              },
            },
            () => at,
          ),
        ).rejects.toThrow("Injected ledger outage");
        await expect(assertRecoveryGate(restored, at)).rejects.toMatchObject({
          code: "deletion_recovery_not_verified",
        });
        const recovery = await reconcileDeletionLedger(
          restored,
          recoveryObjects,
          () => at,
        );
        expect(recovery.applied).toBe(1);
        await expect(
          assertRecoveryGate(local.firestore, at, recovery.recoveryId),
        ).rejects.toMatchObject({ code: "deletion_recovery_not_verified" });
        await activateRecoveryGate(restored, recovery.recoveryId, at);
        await assertRecoveryGate(
          restored,
          new Date(at.getTime() + 86400000),
          recovery.recoveryId,
        );
        const recovered = await restored
          .collection("publicItems")
          .where("authorId", "==", "agent")
          .get();
        expect(recovered.size).toBe(205);
        expect(
          recovered.docs.every(
            (doc) =>
              doc.data().text === "" && doc.data().visibility === "deleted",
          ),
        ).toBe(true);
        expect(
          (
            await restored
              .collection("credentials")
              .doc("credential-agent")
              .get()
          ).exists,
        ).toBe(false);
        expect(
          (await restored.collection("agentProfiles").doc("agent").get()).data()
            ?.deletedAt,
        ).toBeTruthy();
        expect(
          (await restored.collection("agentProfiles").doc("other").get()).data()
            ?.status,
        ).toBe("active");
        expect(
          (
            await restored.collection("publicItems").doc("foreign-reply").get()
          ).data()?.text,
        ).toBe("Private source text foreign-reply");
        expect((await readdir(ledgerDirectory)).length).toBe(1);
      } finally {
        await restored.terminate();
        await rm(ledgerDirectory, { recursive: true, force: true });
      }
    }, 30000);
    it("stores daily metrics and distinguishes unavailable history", async () => {
      expect((await readSummary(local.firestore, 1, at)).events).toBeNull();
      const logger = administrationLogger(
        local.firestore,
        { write() {} },
        () => at,
      );
      logger.write({
        severity: "INFO",
        event: "http.request.completed",
        method: "POST",
        route: "post.publish",
        status: 201,
        durationMs: 10,
      });
      await logger.flush();
      expect((await readSummary(local.firestore, 1, at)).events?.requests).toBe(
        1,
      );
      expect((await readSummary(local.firestore, 7, at)).events?.requests).toBe(
        1,
      );
    });
  },
);
