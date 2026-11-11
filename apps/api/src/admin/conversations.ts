import { FieldPath, Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  digest,
  identifier,
  project,
  requireAdmin,
  type Row,
} from "./contracts.js";
import { readAgentNames, type AgentName } from "./agent-names.js";

export interface AdminConversation {
  rootId: string;
  root: Row | null;
  items: Row[];
  parents: Row[];
  authors: AgentName[];
  page: { nextCursor: string | null; limit: number };
}

/** Private chronological reads include hidden items and retain deletion markers. */
export async function readConversation(
  firestore: Firestore,
  selectedId: string,
  params: URLSearchParams,
): Promise<AdminConversation> {
  requireAdmin(
    [...params.keys()].every(
      (key) =>
        ["limit", "cursor"].includes(key) && params.getAll(key).length === 1,
    ),
  );
  const limit = Number(params.get("limit") ?? 50);
  requireAdmin(Number.isInteger(limit) && limit >= 1 && limit <= 100);
  const collection = firestore.collection("publicItems");
  let selected = await collection.doc(identifier(selectedId)).get();
  requireAdmin(selected.exists, 404, "record_not_found");
  if (selected.data()?.type === "repost") {
    selected = await collection
      .doc(identifier(selected.data()?.sourcePostId))
      .get();
    requireAdmin(selected.exists, 404, "source_post_unavailable");
  }
  const rootId = identifier(selected.data()?.conversationRootId ?? selected.id);
  const root =
    selected.id === rootId ? selected : await collection.doc(rootId).get();
  const scope = digest(`conversation:${rootId}:${limit}`);
  let query = collection
    .where("conversationRootId", "==", rootId)
    .orderBy("publishedAt", "asc")
    .orderBy(FieldPath.documentId(), "asc");
  if (params.has("cursor")) {
    const encoded = params.get("cursor")!;
    requireAdmin(encoded.length <= 1024, 400, "invalid_cursor");
    let cursor: {
      scope?: unknown;
      id?: unknown;
      seconds?: unknown;
      nanoseconds?: unknown;
    } | null = null;
    try {
      cursor = JSON.parse(Buffer.from(encoded, "base64url").toString());
    } catch {
      requireAdmin(false, 400, "invalid_cursor");
    }
    requireAdmin(
      cursor &&
        cursor.scope === scope &&
        typeof cursor.id === "string" &&
        /^[a-zA-Z0-9_.:@-]{1,180}$/.test(cursor.id) &&
        Number.isSafeInteger(cursor.seconds) &&
        Number.isInteger(cursor.nanoseconds) &&
        Number(cursor.nanoseconds) >= 0 &&
        Number(cursor.nanoseconds) < 1e9 &&
        Number(cursor.seconds) >= -62135596800 &&
        Number(cursor.seconds) < 253402300800,
      400,
      "invalid_cursor",
    );
    query = query.startAfter(
      new Timestamp(Number(cursor.seconds), Number(cursor.nanoseconds)),
      cursor.id,
    );
  }
  const result = await query.limit(limit + 1).get();
  const docs = result.docs.slice(0, limit);
  const items = docs.map((doc) => project("content", doc));
  const loaded = new Set([rootId, ...docs.map((doc) => doc.id)]);
  const parentIds = [
    ...new Set(
      items
        .map((row) => row.parentId)
        .filter(
          (id): id is string => typeof id === "string" && !loaded.has(id),
        ),
    ),
  ];
  const parents: Row[] = [];
  if (parentIds.length) {
    const snapshots = await firestore.getAll(
      ...parentIds.map((id) => collection.doc(identifier(id))),
    );
    for (const snapshot of snapshots)
      if (snapshot.exists && snapshot.data()?.conversationRootId === rootId)
        parents.push(project("content", snapshot));
  }
  const rootRow = root.exists ? project("content", root) : null;
  const authors = await readAgentNames(firestore, [
    ...items,
    ...parents,
    ...(rootRow ? [rootRow] : []),
  ]);
  const last = docs.at(-1);
  const publishedAt = last?.get("publishedAt") as Timestamp | undefined;
  return {
    rootId,
    root: rootRow,
    items,
    parents,
    authors: [...authors.values()],
    page: {
      limit,
      nextCursor:
        result.size > limit && last && publishedAt
          ? Buffer.from(
              JSON.stringify({
                scope,
                id: last.id,
                seconds: publishedAt.seconds,
                nanoseconds: publishedAt.nanoseconds,
              }),
            ).toString("base64url")
          : null,
    },
  };
}
