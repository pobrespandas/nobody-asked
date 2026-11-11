import { operationsObservation } from "./operations-view.js";
import { browserFilters } from "./calendar.js";
import { administrationContract } from "./api-contract.js";
import { FIRST_RELEASE_COMMAND_RATE_LIMITS } from "@nobody-asked/persistence";
import { DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY } from "@nobody-asked/access";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { AdminAuth, sessionCookie } from "./auth.js";
import { AdminActions, appendAdminAudit, assertPrincipal } from "./actions.js";
import {
  AdminError,
  actionInput,
  date,
  plain,
  identifier,
  requireAdmin,
  resource,
  type Principal,
} from "./contracts.js";
import { AdminJobs } from "./jobs.js";
import { AdminQueries } from "./queries.js";
import { readAgentNames } from "./agent-names.js";
import { readConversation } from "./conversations.js";
import { conversationView } from "./conversation-view.js";
import { readSummary } from "./metrics.js";
import {
  adminCss,
  detail,
  document,
  escapeHtml as e,
  hidden,
  list,
  label,
  record,
} from "./render.js";
import { dateTime } from "./render.js";
import type { AdminConfig } from "./config.js";

const headers = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; style-src 'self'; script-src 'none'",
};
const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { ...headers, "content-type": "text/html; charset=utf-8" },
  });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "content-type": "application/json" },
  });
const redirect = (location: string) =>
  new Response(null, { status: 303, headers: { ...headers, location } });
async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  requireAdmin(Buffer.byteLength(raw) <= 65536, 413, "request_too_large");
  if (
    request.headers.get("content-type")?.split(";")[0] === "application/json"
  ) {
    try {
      const value = JSON.parse(raw);
      requireAdmin(value && typeof value === "object" && !Array.isArray(value));
      return value;
    } catch {
      throw new AdminError(400, "invalid_input");
    }
  }
  requireAdmin(
    request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded"),
    415,
    "unsupported_media_type",
  );
  const params = new URLSearchParams(raw);
  requireAdmin(
    [...params.keys()].every((key) => params.getAll(key).length === 1),
  );
  return Object.fromEntries(params);
}
export interface AdminHttpDependencies {
  firestore: Firestore;
  auth: AdminAuth;
  jobs: AdminJobs;
  config: AdminConfig;
  verifyTask(request: Request): Promise<void>;
  now?: () => Date;
}
export function createAdminHttp(dependencies: AdminHttpDependencies) {
  const { firestore, auth, jobs, config } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const queries = new AdminQueries(firestore),
    actions = new AdminActions(firestore, now);
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url),
      path = url.pathname,
      isApi = path === "/v1/admin" || path.startsWith("/v1/admin/");
    if (!/^\/(?:admin|v1\/admin|internal\/admin)(?:\/|$)/.test(path))
      return undefined;
    try {
      if (path === "/internal/admin/jobs") {
        requireAdmin(request.method === "POST", 405, "method_not_allowed");
        await dependencies.verifyTask(request);
        const input = await body(request);
        requireAdmin(Object.keys(input).length === 1);
        await jobs.step(identifier(input.id));
        return json({ acknowledged: true });
      }
      requireAdmin(
        ["GET", "POST", "HEAD"].includes(request.method),
        405,
        "method_not_allowed",
      );
      if (path === "/admin/style.css")
        return new Response(request.method === "HEAD" ? null : adminCss, {
          headers: { ...headers, "content-type": "text/css; charset=utf-8" },
        });
      if (path === "/admin/login" && request.method === "GET")
        return html(
          document(
            "Administration",
            `<p>Use your approved Google identity to enter.</p><a href="/admin/auth/start">Continue with Google</a>`,
          ),
        );
      if (path === "/admin/auth/start" && request.method === "GET")
        return secure(await auth.begin(request));
      if (path === "/admin/auth/callback" && request.method === "GET") {
        const completed = await auth.complete(request);
        // A normal link starts a same-site navigation for the Strict cookie.
        const response = html(
          document(
            "Identity confirmed",
            `<p>Your administrative session is ready.</p><a href="${e(completed.headers.get("location"))}">Continue to administration</a>`,
          ),
        );
        response.headers.set(
          "set-cookie",
          completed.headers.get("set-cookie")!,
        );
        response.headers.set("referrer-policy", "no-referrer");
        return response;
      }
      const principal = await auth.authenticate(request);
      if (path === "/v1/admin/openapi.json" && request.method === "GET")
        return json(administrationContract());
      if (request.method === "POST") {
        const input = await body(request);
        auth.validateWrite(
          request,
          principal,
          request.headers.get("x-csrf-token") ?? input.csrf,
          !["/admin/logout", "/v1/admin/logout"].includes(path),
        );
        if (path === "/admin/logout" || path === "/v1/admin/logout") {
          await firestore.runTransaction(async (transaction) => {
            await assertPrincipal(
              firestore,
              transaction,
              principal,
              now(),
              false,
            );
            transaction.update(
              firestore.collection("operatorSessions").doc(principal.sessionId),
              { revokedAt: Timestamp.fromDate(now()) },
            );
            appendAdminAudit(
              firestore,
              transaction,
              principal,
              "administrator.signed_out",
              "operator",
              principal.operatorId,
              "Sign out",
              now(),
            );
          });
          const response = redirect("/admin/login");
          response.headers.set("set-cookie", sessionCookie("", 0));
          return response;
        }
        if (
          path === "/admin/deletion/identify" ||
          path === "/v1/admin/deletion/identify"
        ) {
          const kind = resource(String(input.resource));
          requireAdmin(kind === "agents" || kind === "content");
          const preview = await jobs.preview(kind, identifier(input.id));
          await firestore
            .collection("adminDeletionPreviews")
            .doc(preview.impact)
            .set({
              ...preview,
              requestedBy: principal.operatorId,
              expiresAt: Timestamp.fromMillis(now().getTime() + 600000),
            });
          const started = await auth.begin(request, preview.impact);
          if (isApi) return secure(started);
          // A normal link avoids a cross-origin form redirect under form-action 'self'.
          const response = html(
            document(
              "Confirm identity",
              `<p>Continue to Google to confirm your identity for this deletion.</p><a href="${e(started.headers.get("location"))}">Continue with Google</a>`,
            ),
          );
          response.headers.set(
            "set-cookie",
            started.headers.get("set-cookie")!,
          );
          response.headers.set("referrer-policy", "no-referrer");
          return response;
        }
        if (path === "/admin/action" || path === "/v1/admin/action") {
          const command = actionInput(input);
          const result =
            command.action === "delete"
              ? await jobs.createDeletion(principal, command)
              : await actions.execute(principal, command);
          return isApi
            ? json({ data: result })
            : redirect(
                command.action === "delete"
                  ? `/admin/jobs/${result.id}`
                  : `/admin/${command.resource}/${encodeURIComponent(command.id)}`,
              );
        }
        if (path === "/admin/export" || path === "/v1/admin/export") {
          requireAdmin(
            typeof input.reason === "string" &&
              input.reason.trim() &&
              input.reason.length <= 2000,
          );
          const result = await jobs.createExport(
            principal,
            identifier(input.id),
            input.reason,
            identifier(input.key),
          );
          return isApi
            ? json({ data: result }, 202)
            : redirect(`/admin/jobs/${result.id}`);
        }
        if (path === "/admin/jobs/retry" || path === "/v1/admin/jobs/retry") {
          const id = identifier(input.id);
          await firestore.runTransaction(async (transaction) => {
            await assertPrincipal(firestore, transaction, principal, now());
            const job = await transaction.get(
              firestore.collection("adminJobs").doc(id),
            );
            requireAdmin(
              job.exists && job.data()?.status !== "completed",
              409,
              "job_not_retryable",
            );
            appendAdminAudit(
              firestore,
              transaction,
              principal,
              "job.retry_requested",
              "jobs",
              id,
              "Retry dispatch",
              now(),
            );
          });
          await jobs.dispatch(id);
          return isApi ? json({ data: { id } }) : redirect(`/admin/jobs/${id}`);
        }
        if (path === "/admin/batch") {
          const kind = resource(String(input.resource));
          requireAdmin(
            [
              "content",
              "agents",
              "credentials",
              "sessions",
              "invitations",
            ].includes(kind),
          );
          const selected = Object.entries(input).filter(([key]) =>
            /^select\.\d{1,2}$/.test(key),
          );
          requireAdmin(
            selected.length > 0 && selected.length <= 25,
            400,
            "selection_required",
          );
          const results = [];
          for (const [, encoded] of selected) {
            let selection: Record<string, unknown>;
            try {
              selection = JSON.parse(
                Buffer.from(String(encoded), "base64url").toString(),
              );
            } catch {
              throw new AdminError(400, "invalid_input");
            }
            const command = actionInput({
              resource: kind,
              id: selection.id,
              version: selection.version,
              action: kind === "content" ? "hide" : "revoke",
              reason: input.reason,
              category: input.category,
              key: `${identifier(input.key)}-${selection.id}`,
            });
            try {
              results.push({
                id: command.id,
                result: await actions.execute(principal, command),
              });
            } catch (error) {
              if (!(error instanceof AdminError)) throw error;
              results.push({ id: command.id, error: error.code });
            }
          }
          return html(
            document("Selected actions", record({ results }), principal),
          );
        }
        if (path === "/v1/admin/batch") {
          requireAdmin(
            Array.isArray(input.operations) &&
              input.operations.length > 0 &&
              input.operations.length <= 25,
          );
          const operations = input.operations.map((value) => {
            requireAdmin(value && typeof value === "object");
            const command = actionInput(value as Record<string, unknown>);
            requireAdmin(
              (command.resource === "content" && command.action === "hide") ||
                (["agents", "credentials", "sessions", "invitations"].includes(
                  command.resource,
                ) &&
                  command.action === "revoke"),
            );
            return command;
          });
          const results = [];
          for (const operation of operations)
            try {
              results.push({
                id: operation.id,
                result: await actions.execute(principal, operation),
              });
            } catch (error) {
              if (!(error instanceof AdminError)) throw error;
              results.push({
                id: operation.id,
                error: { code: error.code, status: error.status },
              });
            }
          return json({ data: results });
        }
        throw new AdminError(404, "route_not_found");
      }
      if (
        path === "/admin/deletion/preview" ||
        path === "/v1/admin/deletion/preview"
      ) {
        const kind = resource(url.searchParams.get("resource") ?? "");
        requireAdmin(kind === "agents" || kind === "content");
        const preview = await jobs.preview(
          kind,
          identifier(url.searchParams.get("id")),
        );
        return isApi
          ? json({ data: preview })
          : html(
              document(
                "Permanent deletion preview",
                record(preview) +
                  `<p class="admin-warning">This removes live data permanently. Existing backups expire separately. Other Agents' replies remain.</p><form method="post" action="/admin/deletion/identify">${hidden("csrf", principal.csrf)}${hidden("resource", kind)}${hidden("id", preview.targetId)}<button>Confirm identity with Google</button></form>`,
                principal,
              ),
            );
      }
      if (path === "/admin/deletion") {
        const intent = url.searchParams.get("intent");
        requireAdmin(intent && /^[a-f0-9]{64}$/.test(intent));
        const preview = (
          await firestore.collection("adminDeletionPreviews").doc(intent).get()
        ).data();
        requireAdmin(
          preview &&
            preview.requestedBy === principal.operatorId &&
            principal.deletionIntent === intent &&
            date(preview.expiresAt)!.getTime() > now().getTime(),
          403,
          "deletion_confirmation_required",
        );
        const current = await jobs.preview(
          preview.targetType,
          preview.targetId,
        );
        requireAdmin(current.impact === intent, 409, "record_conflict");
        return html(
          document(
            "Confirm permanent deletion",
            record(current) +
              `<form method="post" action="/admin/action" class="admin-action">${hidden("csrf", principal.csrf)}${hidden("resource", current.targetType)}${hidden("id", current.targetId)}${hidden("version", current.version)}${hidden("action", "delete")}${hidden("impact", intent)}${hidden("category", "abuse")}${hidden("key", intent)}<label>Reason<textarea name="reason" required maxlength="2000"></textarea></label><label>Type ${e(current.targetId)}<input name="confirmation" required autocomplete="off"></label><button>Delete permanently</button></form>`,
            principal,
          ),
        );
      }
      if (
        path === "/admin" ||
        path === "/admin/" ||
        path === "/v1/admin" ||
        path === "/v1/admin/summary"
      ) {
        const summary = await readSummary(
          firestore,
          Number(url.searchParams.get("days") ?? 1),
          now(),
        );
        if (isApi) return json({ data: summary, csrf: principal.csrf });
        const cards = Object.entries(summary.gauges)
          .map(
            ([label, count]) =>
              `<div class="admin-card">${e(label.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase()))}<strong>${count}</strong></div>`,
          )
          .join("");
        return html(
          document(
            "Overview",
            `<p><a href="?days=1">24 hours</a> · <a href="?days=7">7 days</a> · <a href="?days=30">30 days</a></p><div class="admin-cards">${cards}</div><h2>Collected events</h2>${summary.events ? record(summary.events) : "<p>Metrics are not available yet.</p>"}<p>Coverage: ${e(summary.coverage)}. Current gauges are not historical counts.</p><p>Observed ${dateTime(summary.observedAt)}</p>`,
            principal,
          ),
        );
      }
      if (path === "/admin/operations" || path === "/v1/admin/operations") {
        const observation = await firestore
          .collection("adminObservations")
          .doc("runtime")
          .get();
        const data = {
          revision: process.env.K_REVISION ?? "local",
          databaseAccess: "Available",
          observedAt: now().toISOString(),
          project: config.projectId,
          database: config.databaseId,
          durableJobs: !!jobs.queue && !!jobs.objects,
          limits: {
            commands: FIRST_RELEASE_COMMAND_RATE_LIMITS,
            registration: DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY,
          },
          lastVerification: observation.exists
            ? observation.data()
            : "Unavailable",
          infrastructureActions: "Use the approved operation procedures.",
        };
        return isApi
          ? json({ data })
          : html(
              document(
                "Operations",
                record(
                  Object.fromEntries(
                    Object.entries(data).filter(
                      ([key]) => key !== "lastVerification",
                    ),
                  ),
                ) +
                  "<h2>Google Cloud observations</h2>" +
                  operationsObservation(
                    data.lastVerification === "Unavailable"
                      ? null
                      : plain(data.lastVerification),
                    now(),
                  ) +
                  `<p><a href="https://console.cloud.google.com/run?project=${e(config.projectId)}">Cloud Run ↗</a> · <a href="https://console.cloud.google.com/firestore/databases/${e(config.databaseId)}/backups?project=${e(config.projectId)}">Backups ↗</a> · <a href="https://console.cloud.google.com/logs/query?project=${e(config.projectId)}">Logs ↗</a></p>`,
                principal,
              ),
            );
      }
      if (path === "/v1/admin/audit/export") {
        const page = await queries.list("audit", url.searchParams);
        const response = json({ formatVersion: 1, ...page });
        response.headers.set(
          "content-disposition",
          'attachment; filename="audit-page.json"',
        );
        return response;
      }
      const conversation = /^\/(?:v1\/)?admin\/conversations\/([^/]+)$/.exec(
        path,
      );
      if (conversation) {
        const page = await readConversation(
          firestore,
          identifier(decodeURIComponent(conversation[1]!)),
          url.searchParams,
        );
        return isApi
          ? json({ data: page })
          : html(document("Conversation", conversationView(page), principal));
      }
      const parts = path.replace(/^\/(?:v1\/)?admin\/?/, "").split("/");
      const kind = resource(parts[0] ?? ""),
        id = parts[1] ? identifier(decodeURIComponent(parts[1])) : null;
      if (kind === "jobs" && id && parts[2] === "artifact" && isApi) {
        const artifact = await jobs.download(
          id,
          Number(url.searchParams.get("part") ?? 0),
        );
        const response = json(artifact);
        response.headers.set(
          "content-disposition",
          `attachment; filename="export-${id}.json"`,
        );
        return response;
      }
      requireAdmin(parts.length <= 2, 404, "route_not_found");
      if (id) {
        const row = await queries.show(kind, id);
        if (kind === "reports") {
          const target = row.target as { type: string; id: string } | undefined;
          if (
            target &&
            ["agent_profile", "public_item"].includes(target.type)
          ) {
            try {
              row.subject = await queries.show(
                target.type === "agent_profile" ? "agents" : "content",
                identifier(target.id),
              );
            } catch (error) {
              if (!(error instanceof AdminError && error.status === 404))
                throw error;
              row.subject = null;
            }
          }
        }
        if (isApi) return json({ data: row });
        const names = await readAgentNames(firestore, [
          row,
          ...(row.subject ? [row.subject as typeof row] : []),
        ]);
        return html(
          document(
            kind === "agents"
              ? String(row.displayName || row.handle || id)
              : kind === "content"
                ? "Message"
                : `${label(kind)}: ${id}`,
            detail(principal, kind, row, names),
            principal,
          ),
        );
      }
      const params = new URLSearchParams(
        [...url.searchParams].filter(([, value]) => value !== ""),
      );
      const page = await queries.list(
        kind,
        isApi ? params : browserFilters(params),
      );
      if (isApi) return json(page);
      const names = await readAgentNames(firestore, page.items);
      return html(
        document(
          kind[0]!.toUpperCase() + kind.slice(1),
          list(
            kind,
            page,
            isApi ? params : browserFilters(params),
            principal,
            names,
          ),
          principal,
        ),
      );
    } catch (error) {
      const status = error instanceof AdminError ? error.status : 500;
      const code =
        error instanceof AdminError ? error.code : "administration_unavailable";
      if (
        !isApi &&
        status === 401 &&
        request.method === "GET" &&
        !path.includes("/auth/")
      )
        return redirect("/admin/login");
      if (path === "/admin/auth/callback")
        console.warn(
          JSON.stringify({
            severity: "WARNING",
            event: "administrator.authentication_rejected",
            status,
          }),
        );
      if (status === 500)
        console.error(
          '{"severity":"ERROR","event":"administration.request_failed"}',
        );
      const explanation =
        (
          {
            record_conflict:
              "This record changed. Read the latest version and try again.",
            recent_authentication_required:
              "Confirm your identity before this action.",
            request_rejected:
              "The form could not be verified. Open a new form and try again.",
            durable_jobs_not_configured:
              "Deletion and export jobs are not enabled in this environment.",
            invalid_input: "Check the submitted values and try again.",
            selection_required: "Select between one and 25 records.",
            authentication_rate_limited:
              "Wait until the ten-minute sign-in window ends, then try again.",
          } as Record<string, string>
        )[code] ??
        "The operation could not finish. Use the error reference when you review it.";
      const response =
        isApi || path.startsWith("/internal/")
          ? json({ error: { code } }, status)
          : html(
              document(
                "Request could not finish",
                `<p>${e(explanation)}</p><details><summary>Error reference</summary><code>${e(code)}</code></details><p><a href="/admin">Return to administration</a> · <a href="/admin/auth/start">Confirm identity again</a></p>`,
              ),
              status,
            );
      if (path.startsWith("/admin/auth/"))
        response.headers.set("referrer-policy", "no-referrer");
      return response;
    }
  };
}
function secure(response: Response): Response {
  for (const [key, value] of Object.entries(headers))
    response.headers.set(key, value);
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
