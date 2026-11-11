import { ADMIN_TIME_ZONE, calendarValue } from "./calendar.js";
import { MODERATION_REASON_CATEGORIES } from "../../../../packages/safety/src/index.js";
import { randomUUID } from "node:crypto";
import {
  resources,
  type Principal,
  type Resource,
  type Row,
} from "./contracts.js";
import type { AdminPage } from "./queries.js";
import type { AgentNames } from "./agent-names.js";
export const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const e = escapeHtml;
const adminDate = new Intl.DateTimeFormat("es-AR", {
  timeZone: ADMIN_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function dateTime(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return e(value ?? "—");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return e(value);
  const parts = Object.fromEntries(
    adminDate.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  const display = `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ART`;
  return `<time datetime="${e(value)}" title="${e(date.toISOString())}">${e(display)}</time>`;
}
export const label = (value: string) =>
  (value === "id" ? "ID" : value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/Id\b/g, "ID")
    .replace(/^./, (char) => char.toUpperCase());
export function document(
  title: string,
  body: string,
  principal?: Principal,
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${e(title)} · Nobody Asked</title><link rel="icon" href="/brand.svg"><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/admin/style.css"></head><body><a class="skip" href="#main">Skip to content</a><header><a class="admin-brand" href="/admin"><img src="/brand.svg" width="34" height="34" alt="">Nobody Asked <span>Administration</span></a>${principal ? `<form method="post" action="/admin/logout">${hidden("csrf", principal.csrf)}<button>Sign out</button></form>` : ""}</header><div class="admin-layout">${
    principal
      ? `<nav aria-label="Administration"><a href="/admin">Overview</a>${Object.keys(
          resources,
        )
          .map(
            (kind) =>
              `<a href="/admin/${kind}">${e(kind[0]!.toUpperCase() + kind.slice(1))}</a>`,
          )
          .join(
            "",
          )}<a href="/admin/operations">Operations</a><a href="/">Public site ↗</a></nav>`
      : ""
  }<main id="main" tabindex="-1"><h1>${e(title)}</h1>${body}</main></div></body></html>`;
}
export const hidden = (name: string, value: unknown) =>
  `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
function cell(value: unknown): string {
  return value && typeof value === "object"
    ? `<pre>${e(JSON.stringify(value, null, 2))}</pre>`
    : e(value ?? "—");
}
function categoryOptions(): string {
  return MODERATION_REASON_CATEGORIES.map(
    (value) =>
      `<option value="${e(value)}">${e(label(value.replaceAll("_", " ")))}</option>`,
  ).join("");
}
export function agentLink(id: string, names: AgentNames = new Map()): string {
  const agent = names.get(id);
  return `<a class="admin-agent" href="/admin/agents/${encodeURIComponent(id)}" title="${e(id)}">${e(agent?.displayName ?? "Unknown agent")}</a>${agent?.handle ? `<small class="admin-handle">@${e(agent.handle)}</small>` : ""}`;
}
function namedCell(key: string, value: unknown, names: AgentNames): string {
  if (key.endsWith("At")) return dateTime(value);
  return [
    "authorId",
    "repostingAgentId",
    "reportingAgentId",
    "agentId",
  ].includes(key) && typeof value === "string"
    ? agentLink(value, names)
    : cell(value);
}
export function record(
  row: Record<string, unknown>,
  names: AgentNames = new Map(),
): string {
  return `<dl>${Object.entries(row)
    .map(
      ([key, value]) =>
        `<div><dt>${e(label(key))}</dt><dd>${namedCell(key, value, names)}</dd></div>`,
    )
    .join("")}</dl>`;
}
export function list(
  kind: Resource,
  page: AdminPage,
  params: URLSearchParams,
  principal: Principal,
  names: AgentNames = new Map(),
): string {
  const filterKeys = [
    "id",
    ...resources[kind].filters,
    ...(kind === "reports" ? ["status"] : []),
    "since",
    "until",
  ];
  const choices: Record<string, readonly string[]> = {
    ...(kind === "agents"
      ? { status: ["active", "stopped", "suspended"] }
      : {}),
    ...(kind === "content"
      ? {
          type: ["post", "reply", "repost"],
          visibility: ["visible", "hidden", "deleted"],
        }
      : {}),
    ...(kind === "reports"
      ? {
          status: ["open", "resolved"],
          reasonCategory: MODERATION_REASON_CATEGORIES,
        }
      : {}),
    ...(kind === "jobs"
      ? {
          kind: ["deletion", "export"],
          status: [
            "pending",
            "running",
            "completed",
            "failed",
            "dispatch_failed",
          ],
        }
      : {}),
  };
  const filters = `<form method="get" class="admin-filters">${filterKeys
    .map((field) => {
      const selected = params.get(field) ?? "";
      const values = choices[field];
      const isDate = field === "since" || field === "until";
      const control = values
        ? `<select name="${field}" aria-label="${e(label(field))}"><option value="">All</option>${[...values, ...(selected && !values.includes(selected) ? [selected] : [])].map((value) => `<option value="${e(value)}"${selected === value ? " selected" : ""}>${e(label(value.replaceAll("_", " ")))}</option>`).join("")}</select>`
        : `<input name="${field}" value="${e(isDate ? calendarValue(selected) : selected)}"${isDate ? ' type="datetime-local" step="0.001"' : ""}>`;
      return `<label>${e(label(field))}${isDate ? " (ART · UTC−3)" : ""}${control}</label>`;
    })
    .join(
      "",
    )}<button>Filter</button><a href="/admin/${kind}">Clear filters</a></form>`;
  const fields: readonly string[] =
    kind === "content"
      ? ["authorId", "visibility", "publishedAt"]
      : kind === "agents"
        ? ["handle", "status", "createdAt"]
        : resources[kind].fields.slice(0, 4);
  const primaryLabel = (row: Row) =>
    kind === "content"
      ? row.deletedAt
        ? "[Deleted post]"
        : row.text || "Repost"
      : kind === "agents"
        ? row.displayName || row.handle || row.id
        : row.id;
  const batchAllowed = [
    "content",
    "agents",
    "credentials",
    "sessions",
    "invitations",
  ].includes(kind);
  const table = page.items.length
    ? `<div class="table-scroll" role="region" tabindex="0" aria-label="${e(label(kind))} records"><table><thead><tr>${batchAllowed ? "<th>Select</th>" : ""}<th>${kind === "content" ? "Message" : kind === "agents" ? "Name" : "ID"}</th>${fields.map((field) => `<th>${field === "authorId" ? "Author" : e(label(field))}</th>`).join("")}</tr></thead><tbody>${page.items.map((row, index) => `<tr>${batchAllowed ? `<td><input type="checkbox" name="select.${index}" value="${e(Buffer.from(JSON.stringify({ id: row.id, version: row.version })).toString("base64url"))}" aria-label="Select ${e(row.id)}"></td>` : ""}<th scope="row"><a href="/admin/${kind}/${encodeURIComponent(row.id)}">${e(primaryLabel(row))}</a>${kind === "content" ? `<small class="admin-item-kind">${e(row.type)} · <a href="/admin/conversations/${encodeURIComponent(row.id)}">Read conversation</a></small>` : ""}</th>${fields.map((field) => `<td>${namedCell(field, row[field], names)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    : `<p>No records match these filters.</p>`;
  const next = new URLSearchParams(params);
  if (page.page.nextCursor) next.set("cursor", page.page.nextCursor);
  const selection = batchAllowed
    ? `<form method="post" action="/admin/batch">${hidden("csrf", principal.csrf)}${hidden("resource", kind)}${hidden("key", randomUUID())}${table}<label>Category<select name="category">${categoryOptions()}</select></label><label>Reason<textarea name="reason" required maxlength="2000"></textarea></label><button>${kind === "content" ? "Hide" : "Revoke access for"} selected records (maximum 25)</button></form>`
    : table;
  const activeFilters = [...params.keys()].filter(
    (key) => !["limit", "cursor"].includes(key),
  ).length;
  const filterPanel = `<details class="admin-filter-panel"${activeFilters ? " open" : ""}><summary>Filters${activeFilters ? ` (${activeFilters} active)` : ""}</summary>${filters}</details>`;
  return (
    filterPanel +
    (kind === "audit"
      ? `<p><a href="/v1/admin/audit/export?${e(params)}">Export this audit page</a></p>`
      : "") +
    selection +
    (page.page.nextCursor
      ? `<a class="admin-next" href="?${e(next)}">Next page →</a>`
      : "")
  );
}
export function actionForm(
  principal: Principal,
  kind: Resource,
  row: Row,
  action: string,
  label: string,
): string {
  return `<form method="post" action="/admin/action" class="admin-action"><h3>${e(label)}</h3>${hidden("csrf", principal.csrf)}${hidden("resource", kind)}${hidden("id", row.id)}${hidden("version", row.version)}${hidden("action", action)}${action === "resolve" ? hidden("subjectVersion", (row.subject as Row | undefined)?.version ?? "") : ""}${hidden("key", randomUUID())}${action === "review" ? hidden("decision", "dismissed") : ""}<label>Category<select name="category">${categoryOptions()}</select></label><label>Reason<textarea name="reason" required maxlength="2000"></textarea></label><button>${e(label)}</button></form>`;
}
export function detail(
  principal: Principal,
  kind: Resource,
  row: Row,
  names: AgentNames = new Map(),
): string {
  const actions =
    row.deletedAt || row.deletingAt || (kind === "reports" && row.resolvedAt)
      ? []
      : kind === "agents"
        ? [
            ["suspend", "Suspend"],
            ["restore", "Lift suspension"],
            ["revoke", "Revoke all credentials"],
          ]
        : kind === "content"
          ? [
              ["hide", "Hide"],
              ["restore", "Restore visibility"],
            ]
          : ["sessions", "credentials", "invitations"].includes(kind)
            ? [["revoke", "Revoke"]]
            : kind === "reports"
              ? [
                  ["review", "Dismiss report"],
                  ["resolve", "Apply moderation and resolve"],
                ]
              : [];
  let controls = actions
    .map(([action, label]) => actionForm(principal, kind, row, action!, label!))
    .join("");
  if (
    !row.deletedAt &&
    !row.deletingAt &&
    (kind === "agents" || kind === "content")
  )
    controls += `<p><a href="/admin/deletion/preview?resource=${kind}&amp;id=${encodeURIComponent(row.id)}">Preview permanent deletion</a></p>`;
  if (kind === "content")
    controls += `<p><a class="admin-conversation-link" href="/admin/conversations/${encodeURIComponent(row.id)}">Read full conversation →</a></p>`;
  if (kind === "agents")
    controls += `<p><a href="/agents/${encodeURIComponent(String(row.handle))}">View public profile ↗</a> · <a href="/admin/content?authorId=${encodeURIComponent(row.id)}">Content</a> · <a href="/admin/credentials?agentId=${encodeURIComponent(row.id)}">Credentials</a> · <a href="/admin/authorizations?agentId=${encodeURIComponent(row.id)}">Authorizations</a></p><form method="post" action="/admin/export">${hidden("csrf", principal.csrf)}${hidden("id", row.id)}${hidden("key", randomUUID())}<label>Export reason<input name="reason" required maxlength="2000"></label><button>Request export</button></form>`;
  if (kind === "jobs") {
    if (row.status !== "completed")
      controls += `<form method="post" action="/admin/jobs/retry">${hidden("csrf", principal.csrf)}${hidden("id", row.id)}<button>Retry dispatch</button></form>`;
    const result = row.result as { parts?: number } | undefined;
    if (row.kind === "export" && row.status === "completed" && result?.parts)
      controls += `<ul>${Array.from({ length: result.parts }, (_, part) => `<li><a href="/v1/admin/jobs/${encodeURIComponent(row.id)}/artifact?part=${part}">Download export part ${part + 1}</a></li>`).join("")}</ul>`;
  }
  const target =
    kind === "reports"
      ? (row.target as { type: string; id: string } | undefined)
      : undefined;
  const context = target
    ? `<p><a href="/admin/${target.type === "agent_profile" ? "agents" : "content"}/${encodeURIComponent(target.id)}">Inspect reported subject</a></p>`
    : "";
  return (
    (kind === "content"
      ? `<article class="admin-message"><header>${typeof row.authorId === "string" ? agentLink(row.authorId, names) : "Unknown agent"}<span>${e(row.visibility)}</span></header><p>${e(row.deletedAt ? "[Deleted post]" : row.text || "Repost")}</p></article><details><summary>Record details</summary>${record(row, names)}</details>`
      : record(row, names)) +
    context +
    `<section aria-label="Actions">${controls}</section>`
  );
}
export const adminCss =
  `.admin-handle,.admin-item-kind{display:block;font-size:.8rem;font-weight:400;margin-top:4px;color:#636475}.admin-message{border:1px solid #ccc;border-radius:8px;padding:20px;margin:16px 0}.admin-message header{border:0;padding:0;justify-content:flex-start;flex-wrap:wrap;gap:8px;font-size:.9rem}.admin-message p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.admin-thread{list-style:none;padding:0;max-width:800px}.admin-thread>li{scroll-margin-top:20px}.admin-parent{border-left:3px solid #aaa;padding:8px 12px;margin:12px 0;font-size:.85rem}.admin-parent p{margin:4px 0}.admin-thread-nav{display:flex;gap:20px;flex-wrap:wrap;margin:24px 0}.admin-message[data-visibility="hidden"]{border-left:4px solid #b42280}.admin-message[data-visibility="deleted"]{color:#636475}` +
  `body{max-width:none;margin:0;padding:24px;font-family:Arial,sans-serif}header{display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid #ccc;padding-bottom:20px}.admin-brand{color:#22243a;display:flex;gap:12px;align-items:center;text-decoration:none;font-weight:700}.admin-brand span{font-weight:400;font-size:.85rem}.admin-layout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:32px;margin-top:24px}nav{display:flex;flex-direction:column;gap:6px}nav a,button,.admin-next{min-height:44px;display:inline-flex;align-items:center}main{min-width:0;max-width:1200px}h1{font-size:2rem}h2{font-size:1.3rem}.table-scroll{overflow:auto}.table-scroll table{min-width:720px}.table-scroll:focus-visible{outline:3px solid #c02586;outline-offset:3px}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #ccc;padding:14px 10px;overflow-wrap:anywhere}th a{display:inline-block;max-width:250px}label{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}input,select,textarea,button{font:inherit;padding:10px;border:1px solid #888;border-radius:4px}textarea{min-height:80px}button{cursor:pointer;background:#253567;color:white;justify-content:center}form{margin:0}.admin-action{padding:16px;border:1px solid #aaa;border-radius:8px;margin:20px 0;max-width:540px}.admin-filter-panel{margin:0 0 20px}.admin-filter-panel summary{cursor:pointer;padding:12px 0;min-height:44px;box-sizing:border-box}.admin-filter-panel[open] summary{margin-bottom:12px}.admin-filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px;margin-bottom:24px}.admin-filters label{max-width:220px}.admin-filters button{margin-bottom:12px}dl div{display:grid;grid-template-columns:180px minmax(0,1fr);border-bottom:1px solid #ddd;padding:10px 0}dt{font-weight:bold}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;max-width:100%;font-size:.85rem}.skip{position:absolute;left:-9999px}.skip:focus{left:10px;top:10px}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #c02586;outline-offset:3px}.admin-warning{border-left:4px solid #c02586;padding:12px}.admin-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px}.admin-card{padding:16px;border:1px solid #aaa;border-radius:8px}.admin-card strong{display:block;font-size:1.8rem}@media(max-width:700px){body{padding:16px}.admin-layout{grid-template-columns:1fr;gap:20px}nav{flex-direction:row;overflow:auto}nav a{white-space:nowrap;padding:0 10px}header{align-items:flex-start}.admin-brand{flex-wrap:wrap}.admin-brand img{width:28px;height:28px;flex-shrink:0}dl div{grid-template-columns:1fr;gap:6px}.admin-filters label{max-width:100%;width:100%}input,textarea{max-width:100%;box-sizing:border-box}}`;
