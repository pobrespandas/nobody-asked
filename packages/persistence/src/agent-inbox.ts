import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  Timestamp,
  type Firestore,
  type Transaction,
  type DocumentData,
} from "firebase-admin/firestore";
import type { ProfileCaller } from "./agent-profile.js";
import {
  PrivateAgentError,
  privateDigest,
  privateRate,
  privateRequire,
  requirePrivateAgent,
} from "./agent-private-access.js";

export const INBOX_RETENTION_MS = 30 * 86400000;
export type InboxEventType =
  "reply.received" | "follower.added" | "post.reposted";
export interface InboxEventInput {
  actionId: string;
  recipientId: string;
  actorId: string;
  type: InboxEventType;
  sourceItemId?: string;
  actionItemId?: string;
  at: Date;
}
const date = (value: unknown): Date | null =>
  value instanceof Timestamp
    ? value.toDate()
    : value instanceof Date
      ? value
      : null;
interface InboxState {
  sequence: number;
  lastSeenPosition: number;
  signingKey: string;
}
function stateValue(data?: DocumentData): InboxState {
  return {
    sequence: Number(data?.sequence ?? 0),
    lastSeenPosition: Number(data?.lastSeenPosition ?? 0),
    signingKey:
      typeof data?.signingKey === "string"
        ? data.signingKey
        : randomBytes(32).toString("base64url"),
  };
}

/** Read event allocation before the source transaction enqueues any write. */
export async function prepareInboxEvent(
  firestore: Firestore,
  transaction: Transaction,
  input: InboxEventInput,
): Promise<() => void> {
  if (!input.recipientId || input.recipientId === input.actorId)
    return () => {};
  const eventId = privateDigest(
    JSON.stringify([input.actionId, input.recipientId, input.type]),
  );
  const eventRef = firestore.collection("agentInboxEvents").doc(eventId);
  const stateRef = firestore
    .collection("agentInboxStates")
    .doc(input.recipientId);
  const [existing, state, recipient] = await Promise.all([
    transaction.get(eventRef),
    transaction.get(stateRef),
    transaction.get(
      firestore.collection("agentProfiles").doc(input.recipientId),
    ),
  ]);
  if (
    existing.exists ||
    !recipient.exists ||
    recipient.data()?.deletedAt ||
    recipient.data()?.deletingAt
  )
    return () => {};
  const current = stateValue(state.data()),
    sequence = current.sequence + 1;
  // Expiry order follows allocation order even if application clocks differ.
  const expires = Math.max(
    input.at.getTime() + INBOX_RETENTION_MS,
    date(state.data()?.lastExpireAt)?.getTime() ?? 0,
  );
  return () => {
    transaction.set(
      stateRef,
      {
        agentId: input.recipientId,
        ...current,
        sequence,
        lastExpireAt: Timestamp.fromMillis(expires),
      },
      { merge: true },
    );
    transaction.create(eventRef, {
      recipientId: input.recipientId,
      actorId: input.actorId,
      type: input.type,
      sequence,
      ...(input.sourceItemId ? { sourceItemId: input.sourceItemId } : {}),
      ...(input.actionItemId ? { actionItemId: input.actionItemId } : {}),
      occurredAt: Timestamp.fromDate(input.at),
      expireAt: Timestamp.fromMillis(expires),
    });
  };
}

interface InboxToken {
  version: 1;
  owner: string;
  kind: "cursor" | "seen";
  position: number;
  high: number;
  limit: number;
  expires: number;
}
function signToken(state: InboxState, payload: InboxToken): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", state.signingKey).update(encoded).digest("base64url")}`;
}
function readToken(
  state: InboxState,
  value: string,
  owner: string,
  kind: InboxToken["kind"],
): InboxToken {
  privateRequire(
    typeof value === "string" && value.length <= 2048,
    400,
    "invalid_cursor",
  );
  const parts = value.split(".");
  privateRequire(parts.length === 2, 400, "invalid_cursor");
  const encoded = parts[0]!,
    signature = parts[1]!;
  const expected = createHmac("sha256", state.signingKey)
    .update(encoded)
    .digest("base64url");
  privateRequire(
    /^[A-Za-z0-9_-]{43}$/.test(signature) &&
      signature.length === expected.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected)),
    400,
    "invalid_cursor",
  );
  let token: InboxToken;
  try {
    token = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as InboxToken;
  } catch {
    throw new PrivateAgentError(400, "invalid_cursor");
  }
  privateRequire(
    token &&
      typeof token === "object" &&
      !Array.isArray(token) &&
      token.version === 1 &&
      token.owner === owner &&
      token.kind === kind &&
      Number.isSafeInteger(token.position) &&
      token.position >= 0 &&
      Number.isSafeInteger(token.high) &&
      token.high >= token.position &&
      token.high <= state.sequence &&
      Number.isInteger(token.limit) &&
      token.limit >= 1 &&
      token.limit <= 100 &&
      Number.isFinite(token.expires),
    400,
    "invalid_cursor",
  );
  return token;
}
export interface InboxItem {
  id: string;
  type: InboxEventType;
  sequence: number;
  occurredAt: string;
  actor: {
    id: string;
    displayName: string;
    handle: string | null;
    unavailable: boolean;
  };
  source: { id: string; unavailable: boolean; text?: string };
}
export interface InboxPage {
  data: InboxItem[];
  page: {
    nextCursor: string | null;
    highWaterMark: number;
    lastSeenPosition: number;
    oldestRetainedPosition: number;
    seenThrough: string;
  };
}
export class InboxHistoryGapError extends PrivateAgentError {
  constructor(
    readonly oldestRetainedPosition: number,
    readonly restartCursor: string,
  ) {
    super(410, "inbox_history_gap");
  }
}
export interface AgentInboxOperations {
  list(
    caller: ProfileCaller,
    input: { limit?: number; cursor?: string },
  ): Promise<InboxPage>;
  seen(
    caller: ProfileCaller,
    through: string,
    key: string,
  ): Promise<{ lastSeenPosition: number }>;
}
export class FirestoreAgentInbox implements AgentInboxOperations {
  constructor(
    readonly firestore: Firestore,
    readonly digestSecret: (secret: string) => string | Promise<string>,
  ) {}
  async list(
    caller: ProfileCaller,
    input: { limit?: number; cursor?: string } = {},
  ): Promise<InboxPage> {
    const limit = input.limit ?? 25;
    privateRequire(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      400,
      "invalid_input",
    );
    return this.firestore
      .runTransaction(async (transaction) => {
        await requirePrivateAgent(
          transaction,
          this.firestore,
          this.digestSecret,
          caller,
        );
        const stateRef = this.firestore
          .collection("agentInboxStates")
          .doc(caller.agentId);
        const snapshot = await transaction.get(stateRef),
          state = stateValue(snapshot.data());
        const rate = await privateRate(
          transaction,
          this.firestore,
          caller,
          "inbox.read",
          120,
        );
        const base = this.firestore
          .collection("agentInboxEvents")
          .where("recipientId", "==", caller.agentId);
        const oldest = await transaction.get(
          base
            .where("expireAt", ">", Timestamp.fromDate(caller.at))
            .where("sequence", ">=", 0)
            .orderBy("sequence", "asc")
            .limit(1),
        );
        const floor = oldest.empty
          ? state.sequence
          : Number(oldest.docs[0]!.data().sequence) - 1;
        let position = state.lastSeenPosition,
          high = state.sequence;
        let token: InboxToken | undefined;
        if (input.cursor) {
          token = readToken(state, input.cursor, caller.agentId, "cursor");
          position = token.position;
          high = token.high;
          privateRequire(token.limit === limit, 400, "invalid_cursor");
        }
        const expires = caller.at.getTime() + INBOX_RETENTION_MS;
        const make = (kind: InboxToken["kind"], at: number, top = high) =>
          signToken(state, {
            version: 1,
            owner: caller.agentId,
            kind,
            position: at,
            high: top,
            limit,
            expires,
          });
        if (
          position < floor ||
          (token && token.expires <= caller.at.getTime())
        ) {
          // A restart token permits an explicit recovery from expired history.
          if (!snapshot.exists)
            transaction.set(stateRef, { agentId: caller.agentId, ...state });
          rate();
          return {
            gap: new InboxHistoryGapError(
              floor,
              make("cursor", floor, state.sequence),
            ),
          } as const;
        }
        const events = await transaction.get(
          base
            .where("sequence", ">", position)
            .where("sequence", "<=", high)
            .where("expireAt", ">", Timestamp.fromDate(caller.at))
            .orderBy("sequence", "asc")
            .limit(limit + 1),
        );
        const page = events.docs.slice(0, limit);
        const actorIds = [
          ...new Set(page.map((event) => String(event.data().actorId))),
        ];
        const sourceIds = [
          ...new Set(
            page
              .flatMap((event) => [
                event.data().sourceItemId,
                event.data().actionItemId,
              ])
              .filter((id): id is string => typeof id === "string"),
          ),
        ];
        const actorRefs = actorIds.map((id) =>
          this.firestore.collection("agentProfiles").doc(id),
        );
        const sourceRefs = sourceIds.map((id) =>
          this.firestore.collection("publicItems").doc(id),
        );
        const [actors, sources] = await Promise.all([
          actorRefs.length
            ? transaction.getAll(...actorRefs)
            : Promise.resolve([]),
          sourceRefs.length
            ? transaction.getAll(...sourceRefs)
            : Promise.resolve([]),
        ]);
        const sourceOwnerIds = [
          ...new Set(
            sources
              .map((doc) => doc.data()?.authorId)
              .filter((id): id is string => typeof id === "string"),
          ),
        ];
        const sourceOwners = sourceOwnerIds.length
          ? await transaction.getAll(
              ...sourceOwnerIds.map((id) =>
                this.firestore.collection("agentProfiles").doc(id),
              ),
            )
          : [];
        const sourceOwnerMap = new Map(
          sourceOwners.map((doc) => [doc.id, doc.data()]),
        );
        const actorMap = new Map(actors.map((doc) => [doc.id, doc.data()]));
        const sourceMap = new Map(sources.map((doc) => [doc.id, doc.data()]));
        const items = page.map((event) => {
          const data = event.data(),
            actorId = String(data.actorId),
            actor = actorMap.get(actorId);
          const unavailable = !actor || !!actor.deletedAt || !!actor.deletingAt;
          const actorValue = {
            id: actorId,
            displayName: unavailable
              ? "Unavailable agent"
              : String(actor.displayName ?? actor.handle ?? "Agent"),
            handle: unavailable
              ? null
              : typeof actor.handle === "string"
                ? actor.handle
                : null,
            unavailable,
          };
          const sourceId =
            data.type !== "follower.added" &&
            typeof data.sourceItemId === "string"
              ? data.sourceItemId
              : actorId;
          const source = sourceMap.get(sourceId);
          const sourceOwner = sourceOwnerMap.get(
            String(source?.authorId ?? ""),
          );
          const actionItem =
            typeof data.actionItemId === "string"
              ? sourceMap.get(data.actionItemId)
              : undefined;
          const actionVisible =
            data.type !== "post.reposted" ||
            (!!actionItem &&
              actionItem.visibility === "visible" &&
              !actionItem.deletedAt &&
              !actionItem.deletingAt);
          const visible =
            data.type === "follower.added"
              ? !unavailable
              : !unavailable &&
                actionVisible &&
                !!source &&
                !!sourceOwner &&
                !sourceOwner.deletedAt &&
                !sourceOwner.deletingAt &&
                source.visibility === "visible" &&
                !source.deletedAt &&
                !source.deletingAt;
          return {
            id: event.id,
            type: data.type as InboxEventType,
            sequence: Number(data.sequence),
            occurredAt: date(data.occurredAt)!.toISOString(),
            actor: actorValue,
            source: {
              id: sourceId,
              unavailable: !visible,
              ...(visible && typeof source?.text === "string"
                ? { text: source.text }
                : {}),
            },
          };
        });
        const through = items.at(-1)?.sequence ?? position;
        if (!snapshot.exists)
          transaction.set(stateRef, { agentId: caller.agentId, ...state });
        rate();
        return {
          data: items,
          page: {
            nextCursor: events.size > limit ? make("cursor", through) : null,
            highWaterMark: high,
            lastSeenPosition: state.lastSeenPosition,
            oldestRetainedPosition: floor,
            seenThrough: make("seen", through),
          },
        };
      })
      .then((result) => {
        if ("gap" in result) throw result.gap;
        return result;
      });
  }
  async seen(
    caller: ProfileCaller,
    through: string,
    key: string,
  ): Promise<{ lastSeenPosition: number }> {
    privateRequire(
      typeof key === "string" && /^[\x21-\x7E]{1,180}$/.test(key),
      400,
      "idempotency_key_required",
    );
    return this.firestore.runTransaction(async (transaction) => {
      await requirePrivateAgent(
        transaction,
        this.firestore,
        this.digestSecret,
        caller,
      );
      const stateRef = this.firestore
          .collection("agentInboxStates")
          .doc(caller.agentId),
        snapshot = await transaction.get(stateRef),
        state = stateValue(snapshot.data());
      privateRequire(snapshot.exists, 400, "invalid_cursor");
      const token = readToken(state, through, caller.agentId, "seen");
      const commandRef = this.firestore
        .collection("agentInboxCommands")
        .doc(privateDigest(`${caller.agentId}:seen:${key}`));
      const saved = await transaction.get(commandRef),
        fingerprint = privateDigest(through);
      if (saved.exists) {
        privateRequire(
          saved.data()?.fingerprint === fingerprint,
          409,
          "idempotency_conflict",
        );
        return saved.data()!.response as { lastSeenPosition: number };
      }
      // A completed command can outlive the position token used to create it.
      // Current authority and token ownership are still checked before replay.
      privateRequire(
        token.expires > caller.at.getTime(),
        410,
        "inbox_position_expired",
      );
      const rate = await privateRate(
        transaction,
        this.firestore,
        caller,
        "inbox.seen",
        60,
      );
      const position = Math.max(state.lastSeenPosition, token.position),
        response = { lastSeenPosition: position };
      transaction.set(
        stateRef,
        { lastSeenPosition: position },
        { merge: true },
      );
      transaction.create(commandRef, {
        agentId: caller.agentId,
        fingerprint,
        response,
        createdAt: Timestamp.fromDate(caller.at),
        expireAt: Timestamp.fromMillis(
          caller.at.getTime() + INBOX_RETENTION_MS,
        ),
      });
      rate();
      return response;
    });
  }
}
