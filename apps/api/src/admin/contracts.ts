import { isModerationReasonCategory } from "../../../../packages/safety/src/index.js";
import { createHash } from "node:crypto";
import { Timestamp, type DocumentSnapshot } from "firebase-admin/firestore";

export class AdminError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export function requireAdmin(
  condition: unknown,
  status = 400,
  code = "invalid_input",
): asserts condition {
  if (!condition) throw new AdminError(status, code);
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const date = (value: unknown): Date | null =>
  value instanceof Timestamp
    ? value.toDate()
    : value instanceof Date
      ? value
      : null;
export type Row = Record<string, unknown> & { id: string; version: string };
export interface Principal {
  operatorId: string;
  sessionId: string;
  authenticatedAt: Date;
  csrf: string;
  deletionIntent: string | null;
}
export const resources = {
  agents: {
    collection: "agentProfiles",
    fields: [
      "handle",
      "displayName",
      "description",
      "status",
      "createdAt",
      "updatedAt",
      "moderationReasonCategory",
      "moderatedAt",
      "deletingAt",
      "deletedAt",
    ],
    filters: ["handle", "displayName", "status"],
  },
  content: {
    collection: "publicItems",
    fields: [
      "type",
      "authorId",
      "repostingAgentId",
      "sourcePostId",
      "text",
      "parentId",
      "conversationRootId",
      "publishedAt",
      "visibility",
      "moderationReasonCategory",
      "deletedAt",
      "deletingAt",
    ],
    filters: [
      "type",
      "authorId",
      "visibility",
      "parentId",
      "conversationRootId",
    ],
  },
  reports: {
    collection: "reports",
    fields: [
      "reportingAgentId",
      "target",
      "reasonCategory",
      "reportedAt",
      "resolvedAt",
      "decision",
      "internalNote",
      "moderatorId",
    ],
    filters: ["reasonCategory", "reportingAgentId"],
  },
  operators: {
    collection: "operators",
    fields: [
      "normalizedIdentity",
      "createdAt",
      "active",
      "revokedAt",
      "disabledAt",
    ],
    filters: ["normalizedIdentity"],
  },
  authorizations: {
    collection: "agentOperatorAuthorizations",
    fields: [
      "agentId",
      "operatorId",
      "status",
      "requestedAt",
      "expiresAt",
      "acceptedAt",
      "revokedAt",
    ],
    filters: ["agentId", "operatorId"],
  },
  invitations: {
    collection: "operatorInvitations",
    fields: [
      "intendedIdentity",
      "issuedAt",
      "expiresAt",
      "acceptedAt",
      "revokedAt",
    ],
    filters: ["intendedIdentity"],
  },
  sessions: {
    collection: "operatorSessions",
    fields: ["operatorId", "authenticatedAt", "expiresAt", "revokedAt"],
    filters: ["operatorId"],
  },
  credentials: {
    collection: "credentials",
    fields: ["agentId", "createdAt", "lastUsedAt", "expiresAt", "revokedAt"],
    filters: ["agentId"],
  },
  audit: {
    collection: "auditRecords",
    fields: [
      "actorType",
      "actorId",
      "action",
      "subjectType",
      "subjectId",
      "details",
      "createdAt",
    ],
    filters: ["actorId", "subjectId", "action"],
  },
  jobs: {
    collection: "adminJobs",
    fields: [
      "kind",
      "targetType",
      "targetId",
      "status",
      "phase",
      "processed",
      "requestedAt",
      "updatedAt",
      "completedAt",
      "errorCode",
      "requestedBy",
      "reason",
      "result",
    ],
    filters: ["kind", "status", "targetId"],
  },
} as const;
export type Resource = keyof typeof resources;
export function resource(value: string): Resource {
  requireAdmin(Object.hasOwn(resources, value), 404, "resource_not_found");
  return value as Resource;
}
export function identifier(value: unknown): string {
  requireAdmin(
    typeof value === "string" &&
      ![".", ".."].includes(value) &&
      /^[a-zA-Z0-9_.:@-]{1,180}$/.test(value),
  );
  return value;
}
export function plain(value: unknown): unknown {
  if (value instanceof Timestamp || value instanceof Date)
    return date(value)!.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, plain(item)]),
    );
  return value;
}
export function version(snapshot: DocumentSnapshot): string {
  return snapshot.updateTime
    ? `${snapshot.updateTime.seconds}.${snapshot.updateTime.nanoseconds}`
    : "missing";
}
export function project(kind: Resource, snapshot: DocumentSnapshot): Row {
  const data = snapshot.data() ?? {};
  const row: Row = { id: snapshot.id, version: version(snapshot) };
  for (const field of resources[kind].fields)
    if (data[field] !== undefined) row[field] = plain(data[field]);
  if (kind === "authorizations")
    row.status = data.revokedAt
      ? "removed"
      : data.acceptedAt
        ? "active"
        : date(data.expiresAt) && date(data.expiresAt)!.getTime() <= Date.now()
          ? "expired"
          : "pending";
  // Older audit details are allowlisted at the projection boundary as well.
  if (kind === "audit" && data.details)
    row.details = Object.fromEntries(
      [
        "result",
        "reasonCategory",
        "previousState",
        "resultingState",
        "correlationId",
        "jobId",
        "reason",
      ]
        .filter((key) => data.details[key] !== undefined)
        .map((key) => [key, plain(data.details[key])]),
    );
  return row;
}
export interface ActionInput {
  resource: Resource;
  id: string;
  action: string;
  version: string;
  reason: string;
  category: string;
  key: string;
  decision?: string;
  subjectVersion?: string;
  confirmation?: string;
  impact?: string;
}
export function actionInput(input: Record<string, unknown>): ActionInput {
  const allowed = [
    "resource",
    "id",
    "action",
    "version",
    "reason",
    "category",
    "key",
    "decision",
    "subjectVersion",
    "confirmation",
    "impact",
    "csrf",
  ];
  requireAdmin(Object.keys(input).every((key) => allowed.includes(key)));
  const value = {
    ...input,
    resource: resource(String(input.resource)),
    id: identifier(input.id),
  } as unknown as ActionInput;
  requireAdmin(
    typeof value.action === "string" &&
      typeof value.version === "string" &&
      value.version.length < 100,
  );
  requireAdmin(
    typeof value.reason === "string" &&
      value.reason.trim().length > 0 &&
      value.reason.length <= 2000,
  );
  requireAdmin(isModerationReasonCategory(value.category));
  identifier(value.key);
  return value;
}
