import {
  FieldPath,
  Timestamp,
  type Firestore,
  type Query,
} from "firebase-admin/firestore";
import {
  digest,
  project,
  requireAdmin,
  resources,
  type Resource,
  type Row,
} from "./contracts.js";

export interface AdminPage {
  items: Row[];
  page: { nextCursor: string | null };
}
export class AdminQueries {
  constructor(readonly firestore: Firestore) {}
  async show(kind: Resource, id: string): Promise<Row> {
    const snapshot = await this.firestore
      .collection(resources[kind].collection)
      .doc(id)
      .get();
    requireAdmin(snapshot.exists, 404, "record_not_found");
    return project(kind, snapshot);
  }
  async list(kind: Resource, params: URLSearchParams): Promise<AdminPage> {
    const definition = resources[kind];
    const allowed = [
      "limit",
      "cursor",
      "id",
      "since",
      "until",
      ...definition.filters,
      ...(kind === "reports" ? ["status"] : []),
    ];
    requireAdmin(
      [...params.keys()].every((key) => allowed.includes(key)) &&
        [...params.keys()].every((key) => params.getAll(key).length === 1),
    );
    const limit = Number(params.get("limit") ?? 25);
    requireAdmin(Number.isInteger(limit) && limit >= 1 && limit <= 100);
    if (params.has("id")) {
      requireAdmin(
        [...params.keys()].every((key) => ["id", "limit"].includes(key)),
        400,
        "id_filter_is_exclusive",
      );
      const id = params.get("id")!;
      requireAdmin(!id.includes("/") && id.length <= 180);
      const snapshot = await this.firestore
        .collection(definition.collection)
        .doc(id)
        .get();
      return {
        items: snapshot.exists ? [project(kind, snapshot)] : [],
        page: { nextCursor: null },
      };
    }
    let query: Query = this.firestore.collection(definition.collection);
    for (const field of definition.filters)
      if (params.has(field))
        query = query.where(field, "==", params.get(field));
    if (kind === "reports" && params.has("status")) {
      requireAdmin(["open", "resolved"].includes(params.get("status")!));
      query = query.where(
        "resolvedAt",
        params.get("status") === "open" ? "==" : ">",
        params.get("status") === "open" ? null : Timestamp.fromMillis(0),
      );
    }
    const timeField =
      kind === "content"
        ? "publishedAt"
        : kind === "reports"
          ? "reportedAt"
          : kind === "sessions"
            ? "authenticatedAt"
            : kind === "jobs" || kind === "authorizations"
              ? "requestedAt"
              : kind === "invitations"
                ? "issuedAt"
                : "createdAt";
    for (const [param, comparison] of [
      ["since", ">="],
      ["until", "<="],
    ] as const)
      if (params.has(param)) {
        const instant = new Date(params.get(param)!);
        requireAdmin(Number.isFinite(instant.getTime()));
        query = query.where(timeField, comparison, instant);
      }
    // Document ID order also includes legacy records without a creation timestamp.
    const ranged = params.has("since") || params.has("until");
    if (kind === "reports" && params.get("status") === "resolved")
      query = query.orderBy("resolvedAt", "asc");
    if (ranged) query = query.orderBy(timeField, "desc");
    query = query.orderBy(FieldPath.documentId(), "asc");
    const filters = new URLSearchParams(params);
    filters.delete("cursor");
    const scope = digest(
      `${kind}:${[...filters.entries()]
        .sort()
        .map((pair) => pair.join("="))
        .join("&")}`,
    );
    if (params.has("cursor")) {
      requireAdmin(params.get("cursor")!.length <= 1024, 400, "invalid_cursor");
      let cursor: { id: string; scope: string };
      try {
        cursor = JSON.parse(
          Buffer.from(params.get("cursor")!, "base64url").toString(),
        );
      } catch {
        requireAdmin(false, 400, "invalid_cursor");
      }
      requireAdmin(
        cursor &&
          typeof cursor === "object" &&
          !Array.isArray(cursor) &&
          cursor.scope === scope &&
          typeof cursor!.id === "string" &&
          !cursor!.id.includes("/"),
        400,
        "invalid_cursor",
      );
      const snapshot = await this.firestore
        .collection(definition.collection)
        .doc(cursor!.id)
        .get();
      requireAdmin(snapshot.exists, 400, "cursor_record_unavailable");
      query = query.startAfter(snapshot);
    }
    const result = await query.limit(limit + 1).get();
    const docs = result.docs.slice(0, limit);
    return {
      items: docs.map((snapshot) => project(kind, snapshot)),
      page: {
        nextCursor:
          result.size > limit
            ? Buffer.from(
                JSON.stringify({ scope, id: docs.at(-1)!.id }),
              ).toString("base64url")
            : null,
      },
    };
  }
}
