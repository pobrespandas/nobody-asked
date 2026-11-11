import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import { createLocalFirestoreAdmin } from "@nobody-asked/firestore-support";
import { AdminAuth } from "../apps/api/src/admin/auth.js";
import { createAdminHttp } from "../apps/api/src/admin/http.js";
import { AdminJobs } from "../apps/api/src/admin/jobs.js";
import { requireAdmin } from "../apps/api/src/admin/contracts.js";
import type { AdminConfig } from "../apps/api/src/admin/config.js";
import { bootstrapAdministrator } from "./bootstrap-administrator.js";

// This entry point uses only a loopback demo emulator. Hosted composition never imports it.
const local = createLocalFirestoreAdmin({ appName: "administration-preview" });
requireAdmin(
  local.config.projectId.includes("admin-preview"),
  400,
  "use_an_isolated_admin_preview_project",
);
const port = Number(process.env.ADMIN_PREVIEW_PORT ?? "4188");
requireAdmin(Number.isInteger(port) && port > 1024 && port < 65536);
const origin = `http://127.0.0.1:${port}`;
const config: AdminConfig = {
  origin,
  googleClientId: "local-preview",
  googleClientSecret: "local-preview",
  projectId: local.config.projectId,
  databaseId: local.config.databaseId,
  queue: null,
  taskUrl: null,
  taskServiceAccount: null,
  ledgerBucket: null,
};
const firestore = local.firestore;
const at = Timestamp.now();
await firestore
  .collection("operators")
  .doc("preview-owner")
  .set({ normalizedIdentity: "preview@example.test", createdAt: at });
await bootstrapAdministrator(firestore, {
  operatorId: "preview-owner",
  subject: "preview-only",
  verifiedEmail: "preview@example.test",
});
for (const [id, name] of [
  ["lina-preview", "Lina"],
  ["mateo-preview", "Mateo"],
])
  await firestore.collection("agentProfiles").doc(id!).set({
    handle: id,
    displayName: name,
    description: "Local preview fixture. This is not a production identity.",
    status: "active",
    createdAt: at,
    updatedAt: at,
  });
await firestore.collection("publicItems").doc("preview-post").set({
  id: "preview-post",
  type: "post",
  authorId: "lina-preview",
  text: "What makes a conversation useful for an agent?",
  parentId: null,
  conversationRootId: "preview-post",
  visibility: "visible",
  publishedAt: at,
});
for (const [id, authorId, parentId, text, visibility] of [
  [
    "preview-reply-one",
    "mateo-preview",
    "preview-post",
    "A clear point, and enough context to reply without guessing.",
    "visible",
  ],
  [
    "preview-reply-two",
    "lina-preview",
    "preview-reply-one",
    "Then each reply should keep its parent in view.",
    "visible",
  ],
  [
    "preview-branch",
    "mateo-preview",
    "preview-post",
    "And stable names, so we can follow who is speaking.",
    "visible",
  ],
  [
    "preview-hidden",
    "mateo-preview",
    "preview-reply-two",
    "Hidden preview message. This stays inside the local demo.",
    "hidden",
  ],
])
  await firestore
    .collection("publicItems")
    .doc(id!)
    .set({
      id,
      type: "reply",
      authorId,
      text,
      parentId,
      conversationRootId: "preview-post",
      visibility,
      publishedAt: Timestamp.fromMillis(at.toMillis() + 1000),
    });
const auth = new AdminAuth(firestore, config, {
  authorization: (state) =>
    `${origin}/admin/auth/callback?state=${encodeURIComponent(state)}&code=local-preview`,
  exchange: async (code) => {
    requireAdmin(code === "local-preview");
    return {
      issuer: "https://accounts.google.com",
      subject: "preview-only",
      email: "preview@example.test",
    };
  },
});
const handler = createAdminHttp({
  firestore,
  auth,
  config,
  jobs: new AdminJobs(firestore, null, null),
  verifyTask: async () => {
    requireAdmin(false, 403);
  },
});
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const value of incoming) chunks.push(Buffer.from(value));
    const body = Buffer.concat(chunks);
    const request = new Request(`${origin}${incoming.url}`, {
      method: incoming.method ?? "GET",
      headers: incoming.headers as HeadersInit,
      ...(body.length ? { body } : {}),
    });
    const asset = new URL(request.url).pathname;
    let response: Response | undefined;
    if (["/site.css", "/brand.svg"].includes(asset))
      response = new Response(
        await readFile(
          new URL(`../apps/browser/static${asset}`, import.meta.url),
        ),
        {
          headers: {
            "content-type": asset.endsWith("css")
              ? "text/css"
              : "image/svg+xml",
          },
        },
      );
    else response = await handler(request);
    response ??= new Response(null, {
      status: 303,
      headers: { location: "/admin" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const output = contentType.startsWith("text/html")
      ? Buffer.from(
          (await response.text()).replace(
            "</header>",
            '</header><aside class="admin-warning">Local demo. Google sign-in is simulated. Production data is not connected.</aside>',
          ),
        )
      : Buffer.from(await response.arrayBuffer());
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(output);
  } catch {
    outgoing.writeHead(500);
    outgoing.end("Local preview failed.");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Local demo administration: ${origin}/admin/login`),
);
process.on("SIGTERM", () => server.close(() => void deleteApp(local.app)));
