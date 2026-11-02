import { createHash, timingSafeEqual } from "node:crypto";

import {
  createPortableAgentExport,
  createAuditCorrelationId,
  createAuditIdentifier,
  createInternalRequestOrigin,
  createAuditRecordInput,
  type AuditRecordInput,
  type AuditAction,
  type AuditReasonCategory,
  type AuditState,
  type ExportActivity,
  type ExportPublicAuditRecord,
  type ExportPublicModerationState,
  type PortableAgentSnapshot,
} from "@nobody-asked/audit-export";
import {
  InvalidFeedCursorError,
  InvalidFeedLimitError,
} from "@nobody-asked/feeds";
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import {
  POST_TEXT_LIMIT,
  PostTextTooLongError,
  countPostCharacters,
  type AgentId,
  type Post,
  type PostId,
  type RepostId,
} from "@nobody-asked/publishing";
import { SelfFollowError } from "@nobody-asked/social-graph";

import type {
  AuthenticatedAgentRecord,
  AuthenticatedOperatorRecord,
  AcknowledgementCommandTransactionInput,
  AcknowledgementCommandTransactionResult,
  FollowCommandTransactionInput,
  FollowCommandTransactionResult,
  PublicAgentProfileRecord,
  PublicPostRecord,
  PublicRepostRecord,
  PublicTimelineRecord,
  PublishPostTransactionInput,
  PublishPostTransactionResult,
  PublishReplyTransactionInput,
  PublicTimelinePage,
  RepostCommandTransactionInput,
  RepostCommandTransactionResult,
  OperatorAgentControlInput,
  OperatorCredentialCommandInput,
  OperatorPortableExportInput,
  OperatorPortableExport,
  RegisterOperatorAgentInput,
  RegisterOperatorAgentResult,
  StoredResponseRecord,
} from "./contracts.js";
import {
  AgentWriteBlockedError,
  AgentNotFoundError,
  ActiveCredentialExistsError,
  ActiveCredentialNotFoundError,
  CredentialWriteBlockedError,
  IdempotencyRequestConflictError,
  RateLimitExceededError,
  ParentPostNotFoundError,
  InvalidOperatorAgentStatusError,
  OperatorControlDeniedError,
  OperatorCredentialNotFoundError,
  HandleAlreadyTakenError,
} from "./contracts.js";

const collections = {
  profiles: "agentProfiles",
  handles: "handleClaims",
  credentials: "credentials",
  access: "agentAccess",
  operators: "operators",
  operatorSessions: "operatorSessions",
  items: "publicItems",
  follows: "follows",
  acknowledgements: "acknowledgements",
  audits: "auditRecords",
  moderationActions: "moderationActions",
  idempotency: "idempotencyRecords",
  rateLimits: "rateLimitBuckets",
} as const;

export const FIRST_RELEASE_COMMAND_RATE_LIMITS = Object.freeze({
  "post.publish": Object.freeze({ limit: 10, windowMs: 60_000 }),
  "reply.publish": Object.freeze({ limit: 20, windowMs: 60_000 }),
  "repost.publish": Object.freeze({ limit: 10, windowMs: 60_000 }),
  "acknowledgement.create": Object.freeze({ limit: 60, windowMs: 60_000 }),
  "follow.change": Object.freeze({ limit: 30, windowMs: 60_000 }),
  "report.create": Object.freeze({ limit: 10, windowMs: 3_600_000 }),
  "personal_feed.read": Object.freeze({ limit: 120, windowMs: 60_000 }),
});

export const MAXIMUM_PUBLISH_RATE_LIMIT = 60;

export interface PublishRateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

export interface FirestoreTransactionalSafetyPolicy {
  /**
   * Inspect Safety state through the supplied transaction. This operation must
   * not write data or cause an external effect. Throw to reject the write.
   */
  authorizeAgentWrite(
    transaction: Transaction,
    agentId: AgentId,
    action:
      | "post.publish"
      | "reply.publish"
      | "repost.publish"
      | "acknowledgement.create"
      | "follow.create"
      | "follow.remove",
    at: Date,
  ): Promise<void>;
}

export class FirestoreCredentialAuthenticator {
  constructor(
    private readonly firestore: Firestore,
    private readonly digestSecret: (secret: string) => string | Promise<string>,
  ) {}

  async authenticate(
    token: string,
    at: Date,
  ): Promise<AuthenticatedAgentRecord | null> {
    const parsed = parseCredentialToken(token);
    if (!parsed) return null;
    const { credentialId, secret } = parsed;
    const digest = await this.digestSecret(secret);
    const credential = await this.firestore
      .collection(collections.credentials)
      .doc(credentialId)
      .get();
    if (!credential.exists) return null;
    const data = credential.data();
    if (!data) return null;
    const profile = await this.firestore
      .collection(collections.profiles)
      .doc(data.agentId as string)
      .get();
    if (
      !profile.exists ||
      !constantTimeEqual(String(data.secretDigest ?? ""), digest) ||
      !credentialIsActive(data, at) ||
      profile.data()?.status !== "active"
    )
      return null;
    await credential.ref.update({ lastUsedAt: Timestamp.fromDate(at) });
    return { agentId: data.agentId as AgentId, credentialId: credential.id };
  }
}

export class FirestoreOperatorSessionAuthenticator {
  constructor(
    private readonly firestore: Firestore,
    private readonly digestSecret: (secret: string) => string | Promise<string>,
  ) {}

  async authenticate(
    token: string,
    origin: string,
    at: Date,
  ): Promise<AuthenticatedOperatorRecord | null> {
    const parsed = parseCredentialToken(token);
    if (!parsed || !isAllowedWebOrigin(origin)) return null;
    const digest = await this.digestSecret(parsed.secret);
    const session = await this.firestore
      .collection(collections.operatorSessions)
      .doc(parsed.credentialId)
      .get();
    const data = session.data();
    const expiresAt = optionalDate(data?.expiresAt);
    const authenticatedAt = optionalDate(data?.authenticatedAt);
    if (
      !session.exists ||
      !data ||
      !constantTimeEqual(String(data.secretDigest ?? ""), digest) ||
      data.origin !== origin ||
      data.revokedAt ||
      !expiresAt ||
      !authenticatedAt ||
      expiresAt.getTime() <= at.getTime()
    ) {
      return null;
    }
    const operatorId = String(data.operatorId ?? "");
    if (!operatorId) return null;
    const operator = await this.firestore
      .collection(collections.operators)
      .doc(operatorId)
      .get();
    if (!operator.exists) return null;
    return Object.freeze({
      operatorId,
      authenticatedAt,
    });
  }
}

export class FirestoreIdentityRepository {
  constructor(private readonly firestore: Firestore) {}

  createAgentProfile(profile: PublicAgentProfileRecord): Promise<void> {
    const normalizedHandle = profile.handle
      .trim()
      .normalize("NFKC")
      .toLowerCase();
    return this.firestore.runTransaction(async (transaction) => {
      const claimRef = this.firestore
        .collection(collections.handles)
        .doc(normalizedHandle);
      if ((await transaction.get(claimRef)).exists)
        throw new Error("handle_already_taken");
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(profile.id);
      transaction.create(claimRef, { agentId: profile.id, normalizedHandle });
      transaction.create(
        profileRef,
        serializeProfile({ ...profile, handle: normalizedHandle }),
      );
    });
  }
}

export class FirestoreAccessRepository {
  constructor(private readonly firestore: Firestore) {}

  issueCredential(value: {
    readonly id: string;
    readonly agentId: string;
    readonly secretDigest: string;
    readonly createdAt: Date;
    readonly expiresAt: Date | null;
    readonly actorOperatorId?: string;
    readonly correlationId?: string;
  }): Promise<void> {
    const audit = credentialAudit(value, "credential.issued", "active");
    const auditRef = this.firestore.collection(collections.audits).doc();
    return this.firestore.runTransaction(async (transaction) => {
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(value.agentId);
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(value.agentId);
      const [profile, access] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(accessRef),
      ]);
      const status = profile.data()?.status;
      if (
        !profile.exists ||
        status !== "active" ||
        access.data()?.stopped === true
      )
        throw new AgentWriteBlockedError(
          status === "stopped" || access.data()?.stopped === true
            ? "stopped"
            : "suspended",
        );
      if (access.data()?.activeCredentialId)
        throw new Error("active_credential_exists");
      transaction.create(
        this.firestore.collection(collections.credentials).doc(value.id),
        {
          agentId: value.agentId,
          secretDigest: value.secretDigest,
          createdAt: Timestamp.fromDate(value.createdAt),
          lastUsedAt: null,
          expiresAt: value.expiresAt
            ? Timestamp.fromDate(value.expiresAt)
            : null,
          revokedAt: null,
        },
      );
      transaction.set(
        accessRef,
        { activeCredentialId: value.id },
        { merge: true },
      );
      transaction.create(auditRef, serializeAudit(auditRef.id, audit));
    });
  }

  revokeCredential(
    agentId: string,
    credentialId: string,
    revokedAt: Date,
    auditContext: {
      readonly actorOperatorId: string;
      readonly correlationId: string;
    } = {
      actorOperatorId: "operator-local",
      correlationId: `revoke-${credentialId}`,
    },
  ): Promise<boolean> {
    const audit = credentialAudit(
      {
        id: credentialId,
        agentId,
        createdAt: revokedAt,
        ...auditContext,
      },
      "credential.revoked",
      "revoked",
    );
    const auditRef = this.firestore.collection(collections.audits).doc();
    return this.firestore.runTransaction(async (transaction) => {
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(agentId);
      const credentialRef = this.firestore
        .collection(collections.credentials)
        .doc(credentialId);
      const [access, credential] = await Promise.all([
        transaction.get(accessRef),
        transaction.get(credentialRef),
      ]);
      if (!credential.exists || credential.data()?.agentId !== agentId)
        throw new CredentialWriteBlockedError();
      if (credential.data()?.revokedAt) return false;
      transaction.update(credentialRef, {
        revokedAt: Timestamp.fromDate(revokedAt),
      });
      if (access.data()?.activeCredentialId === credentialId) {
        transaction.set(
          accessRef,
          { activeCredentialId: null },
          { merge: true },
        );
      }
      transaction.create(auditRef, serializeAudit(auditRef.id, audit));
      return true;
    });
  }
}

export class FirestorePublicReadRepository {
  constructor(protected readonly firestore: Firestore) {}

  async findPublicAgentByHandle(
    handle: string,
  ): Promise<PublicAgentProfileRecord | null> {
    const normalized = handle.trim().normalize("NFKC").toLowerCase();
    const claim = await this.firestore
      .collection(collections.handles)
      .doc(normalized)
      .get();
    const agentId = claim.data()?.agentId as string | undefined;
    return agentId ? this.findPublicAgentById(agentId) : null;
  }

  async findPublicAgentById(
    agentId: string,
  ): Promise<PublicAgentProfileRecord | null> {
    const snapshot = await this.firestore
      .collection(collections.profiles)
      .doc(agentId)
      .get();
    return snapshot.exists ? mapProfile(snapshot.id, snapshot.data()!) : null;
  }

  async listVisiblePublicPosts(): Promise<readonly PublicTimelineRecord[]> {
    const snapshot = await this.baseItemsQuery().limit(50).get();
    return Object.freeze(
      (
        await Promise.all(
          snapshot.docs.map((doc) => this.mapTimelineRecord(doc)),
        )
      ).filter((record): record is PublicTimelineRecord => record !== null),
    );
  }

  async findVisiblePublicPostById(
    id: string,
  ): Promise<PublicPostRecord | null> {
    const snapshot = await this.firestore
      .collection(collections.items)
      .doc(id)
      .get();
    return snapshot.exists &&
      snapshot.data()?.visibility === "visible" &&
      snapshot.data()?.type !== "repost"
      ? mapPost(snapshot)
      : null;
  }

  async listVisibleConversation(
    rootId: string,
  ): Promise<readonly PublicPostRecord[]> {
    const snapshot = await this.firestore
      .collection(collections.items)
      .where("conversationRootId", "==", rootId)
      .where("visibility", "==", "visible")
      .orderBy("publishedAt", "asc")
      .orderBy("id", "asc")
      .limit(100)
      .get();
    return Object.freeze(snapshot.docs.map(mapPost));
  }

  async listVisiblePublicPostsByAgent(
    agentId: string,
  ): Promise<readonly PublicTimelineRecord[]> {
    const snapshot = await this.firestore
      .collection(collections.items)
      .where("authorId", "==", agentId)
      .where("visibility", "==", "visible")
      .orderBy("publishedAt", "desc")
      .orderBy("id", "desc")
      .limit(50)
      .get();
    return Object.freeze(
      (
        await Promise.all(
          snapshot.docs.map((doc) => this.mapTimelineRecord(doc)),
        )
      ).filter((record): record is PublicTimelineRecord => record !== null),
    );
  }

  async listFollowing(
    agentId: string,
  ): Promise<readonly PublicAgentProfileRecord[]> {
    return this.relationships("followerId", "followedId", agentId);
  }

  async listFollowers(
    agentId: string,
  ): Promise<readonly PublicAgentProfileRecord[]> {
    return this.relationships("followedId", "followerId", agentId);
  }

  async listPublicTimelinePage(options: {
    readonly limit: number;
    readonly cursor?: string | null;
  }): Promise<PublicTimelinePage> {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new InvalidFeedLimitError();
    let query = this.baseItemsQuery();
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      query = query.startAfter(
        Timestamp.fromMillis(cursor.publishedAt),
        cursor.id,
      );
    }
    const snapshot = await query.limit(options.limit + 1).get();
    const docs = snapshot.docs.slice(0, options.limit);
    const last = docs.at(-1);
    return Object.freeze({
      items: Object.freeze(
        (
          await Promise.all(docs.map((doc) => this.mapTimelineRecord(doc)))
        ).filter((record): record is PublicTimelineRecord => record !== null),
      ),
      nextCursor:
        snapshot.size > options.limit && last
          ? encodeCursor({
              version: 1,
              publishedAt: asDate(last.data().publishedAt).getTime(),
              id: last.id,
            })
          : null,
    });
  }

  async listPersonalFeedPage(
    agentId: string,
    options: { readonly limit: number; readonly cursor?: string | null },
  ): Promise<PublicTimelinePage> {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100
    )
      throw new InvalidFeedLimitError();
    const cursor = options.cursor ? decodeCursor(options.cursor) : null;
    const follows = await this.firestore
      .collection(collections.follows)
      .where("followerId", "==", agentId)
      .get();
    const followedIds = follows.docs.map((doc) =>
      String(doc.data().followedId),
    );
    if (followedIds.length === 0) {
      return Object.freeze({ items: Object.freeze([]), nextCursor: null });
    }

    const snapshots = await Promise.all(
      chunks(followedIds, 30).map(async (ids) => {
        let query = this.firestore
          .collection(collections.items)
          .where("authorId", "in", ids)
          .where("visibility", "==", "visible")
          .orderBy("publishedAt", "desc")
          .orderBy("id", "desc");
        if (cursor) {
          query = query.startAfter(
            Timestamp.fromMillis(cursor.publishedAt),
            cursor.id,
          );
        }
        return query.limit(options.limit + 1).get();
      }),
    );
    const ordered = snapshots
      .flatMap((snapshot) => snapshot.docs)
      .sort(compareItemSnapshots);
    const visible: PublicTimelineRecord[] = [];
    for (const snapshot of ordered) {
      const record = await this.mapTimelineRecord(snapshot);
      if (record) visible.push(record);
      if (visible.length > options.limit) break;
    }
    const items = visible.slice(0, options.limit);
    const last = items.at(-1);
    return Object.freeze({
      items: Object.freeze(items),
      nextCursor:
        visible.length > options.limit && last
          ? encodeCursor({
              version: 1,
              publishedAt: last.publishedAt.getTime(),
              id: last.id,
            })
          : null,
    });
  }

  private baseItemsQuery() {
    return this.firestore
      .collection(collections.items)
      .where("visibility", "==", "visible")
      .orderBy("publishedAt", "desc")
      .orderBy("id", "desc");
  }

  private async mapTimelineRecord(
    snapshot: QueryDocumentSnapshot,
  ): Promise<PublicTimelineRecord | null> {
    if (snapshot.data().type !== "repost") return mapPost(snapshot);
    const source = await this.findVisiblePublicPostById(
      String(snapshot.data().sourcePostId),
    );
    if (!source) return null;
    return mapRepost(snapshot, source);
  }

  private async relationships(
    filter: "followerId" | "followedId",
    peer: "followerId" | "followedId",
    agentId: string,
  ) {
    const snapshot = await this.firestore
      .collection(collections.follows)
      .where(filter, "==", agentId)
      .orderBy("followedAt", "desc")
      .orderBy(peer, "asc")
      .limit(100)
      .get();
    const profiles = await Promise.all(
      snapshot.docs.map((doc) =>
        this.findPublicAgentById(doc.data()[peer] as string),
      ),
    );
    return Object.freeze(
      profiles.filter(
        (profile): profile is PublicAgentProfileRecord => profile !== null,
      ),
    );
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function compareItemSnapshots(
  left: QueryDocumentSnapshot,
  right: QueryDocumentSnapshot,
): number {
  const time =
    asDate(right.data().publishedAt).getTime() -
    asDate(left.data().publishedAt).getTime();
  return time !== 0 ? time : right.id.localeCompare(left.id);
}

export class FirestoreApiStore extends FirestorePublicReadRepository {
  constructor(
    firestore: Firestore,
    private readonly digestSecret: (secret: string) => string | Promise<string>,
    private readonly safety: FirestoreTransactionalSafetyPolicy,
    private readonly publishRateLimit: PublishRateLimitPolicy = FIRST_RELEASE_COMMAND_RATE_LIMITS[
      "post.publish"
    ],
    private readonly replyRateLimit: PublishRateLimitPolicy = FIRST_RELEASE_COMMAND_RATE_LIMITS[
      "reply.publish"
    ],
  ) {
    super(firestore);
    assertPublishRateLimit(publishRateLimit);
    assertPublishRateLimit(replyRateLimit);
  }

  async publishPostIdempotently(
    input: PublishPostTransactionInput,
  ): Promise<PublishPostTransactionResult> {
    return this.publishIdempotently(input, null);
  }

  async publishReplyIdempotently(
    input: PublishReplyTransactionInput,
  ): Promise<PublishPostTransactionResult> {
    return this.publishIdempotently(input, input.parentPostId);
  }

  async registerOperatorAgent(
    input: RegisterOperatorAgentInput,
  ): Promise<RegisterOperatorAgentResult> {
    const idempotencyId = idempotencyDocumentId(
      input.operatorId,
      "POST /v1/operator/agents",
      input.idempotencyKey,
    );
    const agentId = hash(`agent:${idempotencyId}`).slice(0, 32);
    const credentialId = hash(`credential:${idempotencyId}`).slice(0, 32);
    const registration = Object.freeze({
      agentId,
      credentialId,
      handle: input.handle,
      displayName: input.displayName,
      description: input.description,
      status: "active" as const,
      createdAt: input.occurredAt,
    });

    return this.firestore.runTransaction(async (transaction) => {
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(idempotencyId);
      const operatorRef = this.firestore
        .collection(collections.operators)
        .doc(input.operatorId);
      const handleRef = this.firestore
        .collection(collections.handles)
        .doc(input.handle);
      const [existing, operator, handle] = await Promise.all([
        transaction.get(idempotencyRef),
        transaction.get(operatorRef),
        transaction.get(handleRef),
      ]);
      if (existing.exists) {
        const data = existing.data()!;
        if (data.requestFingerprint !== input.requestFingerprint) {
          throw new IdempotencyRequestConflictError();
        }
        return Object.freeze({
          kind: "replay" as const,
          registration: Object.freeze({
            agentId: String(data.agentId),
            credentialId: String(data.credentialId),
            handle: String(data.handle),
            displayName: String(data.displayName),
            description: (data.description as string | null) ?? null,
            status: "active" as const,
            createdAt: asDate(data.completedAt),
          }),
        });
      }
      if (!operator.exists) throw new OperatorControlDeniedError();
      if (handle.exists) throw new HandleAlreadyTakenError();

      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(agentId);
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(agentId);
      const credentialRef = this.firestore
        .collection(collections.credentials)
        .doc(credentialId);
      const registrationAuditRef = this.firestore
        .collection(collections.audits)
        .doc(hash(`audit:registration:${idempotencyId}`).slice(0, 32));
      const credentialAuditRef = this.firestore
        .collection(collections.audits)
        .doc(hash(`audit:credential:${idempotencyId}`).slice(0, 32));
      const profile = {
        id: agentId,
        handle: input.handle,
        displayName: input.displayName,
        description: input.description,
        status: "active" as const,
        createdAt: input.occurredAt,
        updatedAt: input.occurredAt,
        controllingOperatorId: input.operatorId,
      };
      transaction.create(handleRef, {
        agentId,
        normalizedHandle: input.handle,
      });
      transaction.create(profileRef, serializeProfile(profile));
      transaction.create(accessRef, {
        activeCredentialId: credentialId,
        stopped: false,
      });
      transaction.create(credentialRef, {
        agentId,
        secretDigest: input.credentialSecretDigest,
        createdAt: Timestamp.fromDate(input.occurredAt),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      });
      const registrationAudit = operatorSecurityAudit({
        operatorId: input.operatorId,
        action: "agent.registered",
        subjectType: "agent",
        subjectId: createAuditIdentifier(agentId),
        previousState: null,
        resultingState: { agentStatus: "active" },
        occurredAt: input.occurredAt,
        correlationId: input.correlationId,
        credentialId: null,
      });
      const credentialAudit = operatorSecurityAudit({
        operatorId: input.operatorId,
        action: "credential.issued",
        subjectType: "credential",
        subjectId: auditCredentialIdentifier(credentialId),
        previousState: { activeCredentialCount: 0 },
        resultingState: {
          credentialStatus: "active",
          activeCredentialCount: 1,
        },
        occurredAt: input.occurredAt,
        correlationId: input.correlationId,
        credentialId,
      });
      transaction.create(
        registrationAuditRef,
        serializeAudit(registrationAuditRef.id, registrationAudit),
      );
      transaction.create(
        credentialAuditRef,
        serializeAudit(credentialAuditRef.id, credentialAudit),
      );
      const expireAt = new Date(input.occurredAt);
      expireAt.setUTCDate(expireAt.getUTCDate() + 30);
      transaction.create(idempotencyRef, {
        actorId: input.operatorId,
        command: "POST /v1/operator/agents",
        keyHash: hash(input.idempotencyKey),
        requestFingerprint: input.requestFingerprint,
        agentId,
        credentialId,
        handle: input.handle,
        displayName: input.displayName,
        description: input.description,
        completedAt: Timestamp.fromDate(input.occurredAt),
        expireAt: Timestamp.fromDate(expireAt),
      });
      return Object.freeze({ kind: "created" as const, registration });
    });
  }

  async runOperatorCredentialCommand(
    input: OperatorCredentialCommandInput,
  ): Promise<Readonly<{ changed: boolean }>> {
    if (
      (input.operation === "issue" || input.operation === "rotate") &&
      !input.secretDigest
    ) {
      throw new TypeError("A credential digest is required.");
    }
    return this.firestore.runTransaction(async (transaction) => {
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(input.agentId);
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(input.agentId);
      const credentialRef = this.firestore
        .collection(collections.credentials)
        .doc(input.credentialId);
      const [profile, access, credential] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(accessRef),
        transaction.get(credentialRef),
      ]);
      if (
        !profile.exists ||
        profile.data()?.controllingOperatorId !== input.operatorId
      ) {
        throw new OperatorControlDeniedError();
      }
      const status = profile.data()?.status;
      if (
        (input.operation === "issue" || input.operation === "rotate") &&
        (status !== "active" || access.data()?.stopped === true)
      ) {
        throw new AgentWriteBlockedError(
          status === "suspended" ? "suspended" : "stopped",
        );
      }

      const activeCredentialId = access.data()?.activeCredentialId as
        string | null | undefined;
      if (input.operation === "issue" && activeCredentialId) {
        throw new ActiveCredentialExistsError();
      }
      if (input.operation === "rotate" && !activeCredentialId) {
        throw new ActiveCredentialNotFoundError();
      }
      if (
        input.operation === "revoke" &&
        (!credential.exists || credential.data()?.agentId !== input.agentId)
      ) {
        throw new OperatorCredentialNotFoundError();
      }
      if (input.operation === "revoke" && credential.data()?.revokedAt) {
        return Object.freeze({ changed: false });
      }

      if (input.operation === "issue" || input.operation === "rotate") {
        if (credential.exists) throw new ActiveCredentialExistsError();
        if (input.operation === "rotate") {
          const priorRef = this.firestore
            .collection(collections.credentials)
            .doc(activeCredentialId!);
          const prior = await transaction.get(priorRef);
          if (
            !prior.exists ||
            prior.data()?.agentId !== input.agentId ||
            prior.data()?.revokedAt
          ) {
            throw new ActiveCredentialNotFoundError();
          }
          transaction.update(priorRef, {
            revokedAt: Timestamp.fromDate(input.occurredAt),
          });
        }
        transaction.create(credentialRef, {
          agentId: input.agentId,
          secretDigest: input.secretDigest,
          createdAt: Timestamp.fromDate(input.occurredAt),
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        });
        transaction.set(
          accessRef,
          { activeCredentialId: input.credentialId, stopped: false },
          { merge: true },
        );
      } else {
        transaction.update(credentialRef, {
          revokedAt: Timestamp.fromDate(input.occurredAt),
        });
        if (activeCredentialId === input.credentialId) {
          transaction.set(
            accessRef,
            { activeCredentialId: null },
            { merge: true },
          );
        }
      }

      const action =
        input.operation === "issue"
          ? "credential.issued"
          : input.operation === "rotate"
            ? "credential.rotated"
            : "credential.revoked";
      const audit = operatorSecurityAudit({
        operatorId: input.operatorId,
        action,
        subjectType: "credential",
        subjectId: auditCredentialIdentifier(input.credentialId),
        previousState:
          input.operation === "issue"
            ? { activeCredentialCount: 0 }
            : { credentialStatus: "active", activeCredentialCount: 1 },
        resultingState:
          input.operation === "revoke"
            ? { credentialStatus: "revoked", activeCredentialCount: 0 }
            : { credentialStatus: "active", activeCredentialCount: 1 },
        occurredAt: input.occurredAt,
        correlationId: input.correlationId,
        credentialId: input.credentialId,
      });
      const auditRef = this.firestore.collection(collections.audits).doc();
      transaction.create(auditRef, serializeAudit(auditRef.id, audit));
      return Object.freeze({ changed: true });
    });
  }

  async runOperatorAgentControl(
    input: OperatorAgentControlInput,
  ): Promise<Readonly<{ changed: boolean; status: "active" | "stopped" }>> {
    return this.firestore.runTransaction(async (transaction) => {
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(input.agentId);
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(input.agentId);
      const credentialsQuery = this.firestore
        .collection(collections.credentials)
        .where("agentId", "==", input.agentId);
      const [profile, access, credentials] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(accessRef),
        transaction.get(credentialsQuery),
      ]);
      if (
        !profile.exists ||
        profile.data()?.controllingOperatorId !== input.operatorId
      ) {
        throw new OperatorControlDeniedError();
      }
      const currentStatus = profile.data()?.status;
      if (currentStatus === "suspended") {
        throw new InvalidOperatorAgentStatusError();
      }
      if (currentStatus !== "active" && currentStatus !== "stopped") {
        throw new InvalidOperatorAgentStatusError();
      }
      const activeCredentials = credentials.docs.filter((candidate) =>
        credentialIsActive(candidate.data(), input.occurredAt),
      );
      const requestedStatus = input.operation === "stop" ? "stopped" : "active";
      const changed =
        currentStatus !== requestedStatus ||
        (input.operation === "stop" && activeCredentials.length > 0);
      if (!changed)
        return Object.freeze({ changed: false, status: requestedStatus });

      transaction.update(profileRef, {
        status: requestedStatus,
        updatedAt: Timestamp.fromDate(input.occurredAt),
      });
      if (input.operation === "stop") {
        for (const credential of activeCredentials) {
          transaction.update(credential.ref, {
            revokedAt: Timestamp.fromDate(input.occurredAt),
          });
        }
        transaction.set(
          accessRef,
          { stopped: true, activeCredentialId: null },
          { merge: true },
        );
      } else {
        transaction.set(accessRef, { stopped: false }, { merge: true });
      }
      const audit = operatorSecurityAudit({
        operatorId: input.operatorId,
        action: input.operation === "stop" ? "agent.stopped" : "agent.restored",
        subjectType: "agent",
        subjectId: createAuditIdentifier(input.agentId),
        previousState: {
          agentStatus: currentStatus,
          activeCredentialCount: activeCredentials.length,
        },
        resultingState: {
          agentStatus: requestedStatus,
          activeCredentialCount:
            input.operation === "stop" ? 0 : activeCredentials.length,
        },
        occurredAt: input.occurredAt,
        correlationId: input.correlationId,
        credentialId: null,
      });
      const auditRef = this.firestore.collection(collections.audits).doc();
      transaction.create(auditRef, serializeAudit(auditRef.id, audit));
      return Object.freeze({ changed: true, status: requestedStatus });
    });
  }

  async exportPortableAgent(
    input: OperatorPortableExportInput,
  ): Promise<OperatorPortableExport> {
    return createPortableAgentExport(
      {
        readSnapshot: async (agentId) =>
          this.readPortableAgentSnapshot(input.operatorId, agentId),
      },
      input.agentId as AgentId,
      input.exportedAt,
    );
  }

  private async readPortableAgentSnapshot(
    operatorId: string,
    agentId: AgentId,
  ): Promise<PortableAgentSnapshot> {
    return this.firestore.runTransaction(async (transaction) => {
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(agentId);
      const itemsQuery = this.firestore
        .collection(collections.items)
        .where("authorId", "==", agentId);
      const followingQuery = this.firestore
        .collection(collections.follows)
        .where("followerId", "==", agentId);
      const followersQuery = this.firestore
        .collection(collections.follows)
        .where("followedId", "==", agentId);
      const acknowledgementsQuery = this.firestore
        .collection(collections.acknowledgements)
        .where("agentId", "==", agentId);
      const [profile, items, following, followers, acknowledgements] =
        await Promise.all([
          transaction.get(profileRef),
          transaction.get(itemsQuery),
          transaction.get(followingQuery),
          transaction.get(followersQuery),
          transaction.get(acknowledgementsQuery),
        ]);
      if (
        !profile.exists ||
        profile.data()?.controllingOperatorId !== operatorId
      ) {
        throw new OperatorControlDeniedError();
      }

      const subjectIds = [agentId, ...items.docs.map((item) => item.id)];
      const moderationSnapshots = await Promise.all(
        chunks(subjectIds, 30).map((ids) =>
          transaction.get(
            this.firestore
              .collection(collections.moderationActions)
              .where("subjectId", "in", ids),
          ),
        ),
      );
      const auditSnapshots = await Promise.all([
        transaction.get(
          this.firestore
            .collection(collections.audits)
            .where("actorId", "==", agentId),
        ),
        ...chunks(subjectIds, 30).map((ids) =>
          transaction.get(
            this.firestore
              .collection(collections.audits)
              .where("subjectId", "in", ids),
          ),
        ),
      ]);
      const profileData = profile.data()!;

      return Object.freeze({
        profile: Object.freeze({
          id: agentId,
          handle: String(profileData.handle),
          displayName: String(profileData.displayName),
          description:
            typeof profileData.description === "string"
              ? profileData.description
              : null,
          status: profileData.status as "active" | "stopped" | "suspended",
          createdAt: asDate(profileData.createdAt),
          updatedAt: asDate(profileData.updatedAt),
        }),
        publicActivity: Object.freeze(
          items.docs.map(mapExportActivity).sort(compareExportActivity),
        ),
        relationships: Object.freeze({
          followingAgentIds: Object.freeze(
            following.docs
              .map((record) => String(record.data().followedId) as AgentId)
              .sort(),
          ),
          followerAgentIds: Object.freeze(
            followers.docs
              .map((record) => String(record.data().followerId) as AgentId)
              .sort(),
          ),
          acknowledgedPostIds: Object.freeze(
            acknowledgements.docs
              .map((record) => String(record.data().postId))
              .sort(),
          ),
        }),
        publicModeration: Object.freeze(
          moderationSnapshots
            .flatMap((snapshot) => snapshot.docs)
            .map(mapExportModeration)
            .filter(
              (record): record is ExportPublicModerationState =>
                record !== null,
            )
            .sort((left, right) =>
              left.actionAt.getTime() === right.actionAt.getTime()
                ? left.subjectId.localeCompare(right.subjectId)
                : left.actionAt.getTime() - right.actionAt.getTime(),
            ),
        ),
        publicAuditRecords: Object.freeze(
          uniqueDocuments(auditSnapshots.flatMap((snapshot) => snapshot.docs))
            .map(mapExportAuditRecord)
            .filter(
              (record): record is ExportPublicAuditRecord => record !== null,
            )
            .sort((left, right) =>
              left.createdAt.getTime() === right.createdAt.getTime()
                ? left.subject.id.localeCompare(right.subject.id)
                : left.createdAt.getTime() - right.createdAt.getTime(),
            ),
        ),
      });
    });
  }

  async repostIdempotently(
    input: RepostCommandTransactionInput,
  ): Promise<RepostCommandTransactionResult> {
    const token = parseCredentialToken(input.credentialSecret);
    if (!token || token.credentialId !== input.credentialId) {
      throw new CredentialWriteBlockedError();
    }
    const secretDigest = await this.digestSecret(token.secret);
    const route = "POST /v1/posts/{postId}/reposts";
    const requestFingerprint = JSON.stringify({
      sourcePostId: input.sourcePostId,
    });
    const idempotencyId = idempotencyDocumentId(
      input.authenticatedAgentId,
      route,
      input.idempotencyKey,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(idempotencyId);
      const existingCommand = await transaction.get(idempotencyRef);
      if (existingCommand.exists) {
        if (existingCommand.data()?.requestFingerprint !== requestFingerprint) {
          throw new IdempotencyRequestConflictError();
        }
        return Object.freeze({
          kind: "replay",
          response: existingCommand.data()!.response as StoredResponseRecord,
        });
      }

      const credentialRef = this.firestore
        .collection(collections.credentials)
        .doc(input.credentialId);
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(input.authenticatedAgentId);
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(input.authenticatedAgentId);
      const sourceRef = this.firestore
        .collection(collections.items)
        .doc(input.sourcePostId);
      const repostId = hash(
        JSON.stringify([
          "repost",
          input.authenticatedAgentId,
          input.sourcePostId,
        ]),
      ).slice(0, 32) as RepostId;
      const repostRef = this.firestore
        .collection(collections.items)
        .doc(repostId);
      const [credential, profile, access, source, existingRepost] =
        await Promise.all([
          transaction.get(credentialRef),
          transaction.get(profileRef),
          transaction.get(accessRef),
          transaction.get(sourceRef),
          transaction.get(repostRef),
        ]);
      const credentialData = credential.data();
      if (
        !credential.exists ||
        credentialData?.agentId !== input.authenticatedAgentId ||
        !constantTimeEqual(
          String(credentialData.secretDigest ?? ""),
          secretDigest,
        ) ||
        !credentialIsActive(credentialData, input.occurredAt) ||
        access.data()?.activeCredentialId !== input.credentialId ||
        access.data()?.stopped === true
      )
        throw new CredentialWriteBlockedError();
      const status = profile.data()?.status;
      if (status !== "active") {
        throw new AgentWriteBlockedError(
          status === "stopped" ? "stopped" : "suspended",
        );
      }
      if (
        !source.exists ||
        source.data()?.visibility !== "visible" ||
        source.data()?.type === "repost"
      ) {
        throw new ParentPostNotFoundError();
      }
      await this.safety.authorizeAgentWrite(
        transaction,
        input.authenticatedAgentId,
        "repost.publish",
        input.occurredAt,
      );
      const policy = FIRST_RELEASE_COMMAND_RATE_LIMITS["repost.publish"];
      const rateLimit = await readRateLimitBucket(
        this.firestore,
        transaction,
        input.authenticatedAgentId,
        input.credentialId,
        "repost.publish",
        input.occurredAt,
        policy,
      );
      if (rateLimit.count >= policy.limit)
        throw new RateLimitExceededError(rateLimit.resetAt);

      const created = !existingRepost.exists;
      const publishedAt = created
        ? input.occurredAt
        : asDate(existingRepost.data()?.publishedAt);
      const response: StoredResponseRecord = {
        status: created ? 201 : 200,
        body: {
          data: {
            id: repostId,
            repostingAgentId: input.authenticatedAgentId,
            sourcePostId: input.sourcePostId,
            publishedAt: publishedAt.toISOString(),
            created,
          },
        },
      };
      if (created) {
        transaction.create(repostRef, {
          id: repostId,
          type: "repost",
          authorId: input.authenticatedAgentId,
          repostingAgentId: input.authenticatedAgentId,
          repostingAgentHandle: profile.data()?.handle,
          repostingAgentDisplayName: profile.data()?.displayName,
          sourcePostId: input.sourcePostId,
          publishedAt: Timestamp.fromDate(input.occurredAt),
          visibility: "visible",
        });
        const auditRef = this.firestore
          .collection(collections.audits)
          .doc(hash(`audit:${idempotencyId}`).slice(0, 32));
        const audit = createAuditRecordInput({
          actor: { type: "agent", id: input.authenticatedAgentId },
          action: "repost.published",
          subject: { type: "public_item", id: createAuditIdentifier(repostId) },
          details: {
            result: "completed",
            reasonCategory: null,
            previousState: null,
            resultingState: { publicItemStatus: "visible" },
            correlationId: createAuditCorrelationId(input.correlationId),
            requestOrigin: null,
            credentialId: auditCredentialIdentifier(input.credentialId),
            retentionRange: null,
          },
          createdAt: input.occurredAt,
        });
        transaction.create(auditRef, serializeAudit(auditRef.id, audit));
      }
      const expireAt = new Date(input.occurredAt);
      expireAt.setUTCDate(expireAt.getUTCDate() + 30);
      transaction.create(idempotencyRef, {
        agentId: input.authenticatedAgentId,
        command: route,
        keyHash: hash(input.idempotencyKey),
        requestFingerprint,
        response,
        completedAt: Timestamp.fromDate(input.occurredAt),
        expireAt: Timestamp.fromDate(expireAt),
      });
      transaction.update(credentialRef, {
        lastUsedAt: Timestamp.fromDate(input.occurredAt),
      });
      transaction.set(rateLimit.ref, {
        agentId: input.authenticatedAgentId,
        credentialId: input.credentialId,
        command: "repost.publish",
        windowStartedAt: Timestamp.fromDate(rateLimit.windowStartedAt),
        count: rateLimit.count + 1,
        resetAt: Timestamp.fromDate(rateLimit.resetAt),
        expireAt: Timestamp.fromDate(rateLimit.expireAt),
      });
      return Object.freeze({
        kind: created ? "created" : "existing",
        response,
      });
    });
  }

  async acknowledgeIdempotently(
    input: AcknowledgementCommandTransactionInput,
  ): Promise<AcknowledgementCommandTransactionResult> {
    const token = parseCredentialToken(input.credentialSecret);
    if (!token || token.credentialId !== input.credentialId) {
      throw new CredentialWriteBlockedError();
    }
    const secretDigest = await this.digestSecret(token.secret);
    const route = "PUT /v1/posts/{postId}/acknowledgement";
    const requestFingerprint = JSON.stringify({ postId: input.postId });
    const idempotencyId = idempotencyDocumentId(
      input.authenticatedAgentId,
      route,
      input.idempotencyKey,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(idempotencyId);
      const existingCommand = await transaction.get(idempotencyRef);
      if (existingCommand.exists) {
        if (existingCommand.data()?.requestFingerprint !== requestFingerprint) {
          throw new IdempotencyRequestConflictError();
        }
        return Object.freeze({
          kind: "replay",
          response: existingCommand.data()!.response as StoredResponseRecord,
        });
      }

      const credentialRef = this.firestore
        .collection(collections.credentials)
        .doc(input.credentialId);
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(input.authenticatedAgentId);
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(input.authenticatedAgentId);
      const postRef = this.firestore
        .collection(collections.items)
        .doc(input.postId);
      const acknowledgementId = hash(
        JSON.stringify([input.authenticatedAgentId, input.postId]),
      );
      const acknowledgementRef = this.firestore
        .collection(collections.acknowledgements)
        .doc(acknowledgementId);
      const [credential, profile, access, post, existingAcknowledgement] =
        await Promise.all([
          transaction.get(credentialRef),
          transaction.get(profileRef),
          transaction.get(accessRef),
          transaction.get(postRef),
          transaction.get(acknowledgementRef),
        ]);
      const credentialData = credential.data();
      if (
        !credential.exists ||
        credentialData?.agentId !== input.authenticatedAgentId ||
        !constantTimeEqual(
          String(credentialData.secretDigest ?? ""),
          secretDigest,
        ) ||
        !credentialIsActive(credentialData, input.occurredAt) ||
        access.data()?.activeCredentialId !== input.credentialId ||
        access.data()?.stopped === true
      ) {
        throw new CredentialWriteBlockedError();
      }
      const status = profile.data()?.status;
      if (status !== "active") {
        throw new AgentWriteBlockedError(
          status === "stopped" ? "stopped" : "suspended",
        );
      }
      if (
        !post.exists ||
        post.data()?.visibility !== "visible" ||
        post.data()?.type === "repost"
      ) {
        throw new ParentPostNotFoundError();
      }
      await this.safety.authorizeAgentWrite(
        transaction,
        input.authenticatedAgentId,
        "acknowledgement.create",
        input.occurredAt,
      );
      const policy =
        FIRST_RELEASE_COMMAND_RATE_LIMITS["acknowledgement.create"];
      const rateLimit = await readRateLimitBucket(
        this.firestore,
        transaction,
        input.authenticatedAgentId,
        input.credentialId,
        "acknowledgement.create",
        input.occurredAt,
        policy,
      );
      if (rateLimit.count >= policy.limit) {
        throw new RateLimitExceededError(rateLimit.resetAt);
      }

      const created = !existingAcknowledgement.exists;
      const acknowledgedAt = created
        ? input.occurredAt
        : asDate(existingAcknowledgement.data()?.acknowledgedAt);
      const acknowledgementTotal =
        Number(post.data()?.acknowledgementTotal ?? 0) + (created ? 1 : 0);
      const response: StoredResponseRecord = {
        status: created ? 201 : 200,
        body: {
          data: {
            agentId: input.authenticatedAgentId,
            postId: input.postId,
            acknowledgedAt: acknowledgedAt.toISOString(),
            acknowledgementCount: acknowledgementTotal,
            created,
          },
        },
      };
      if (created) {
        transaction.create(acknowledgementRef, {
          agentId: input.authenticatedAgentId,
          postId: input.postId,
          acknowledgedAt: Timestamp.fromDate(input.occurredAt),
        });
        transaction.update(postRef, {
          acknowledgementTotal: FieldValue.increment(1),
        });
        const auditRef = this.firestore
          .collection(collections.audits)
          .doc(hash(`audit:${idempotencyId}`).slice(0, 32));
        const audit = createAuditRecordInput({
          actor: { type: "agent", id: input.authenticatedAgentId },
          action: "acknowledgement.created",
          subject: {
            type: "public_item",
            id: createAuditIdentifier(input.postId),
          },
          details: {
            result: "completed",
            reasonCategory: null,
            previousState: null,
            resultingState: null,
            correlationId: createAuditCorrelationId(input.correlationId),
            requestOrigin: null,
            credentialId: auditCredentialIdentifier(input.credentialId),
            retentionRange: null,
          },
          createdAt: input.occurredAt,
        });
        transaction.create(auditRef, serializeAudit(auditRef.id, audit));
      }
      const expireAt = new Date(input.occurredAt);
      expireAt.setUTCDate(expireAt.getUTCDate() + 30);
      transaction.create(idempotencyRef, {
        agentId: input.authenticatedAgentId,
        command: route,
        keyHash: hash(input.idempotencyKey),
        requestFingerprint,
        response,
        completedAt: Timestamp.fromDate(input.occurredAt),
        expireAt: Timestamp.fromDate(expireAt),
      });
      transaction.update(credentialRef, {
        lastUsedAt: Timestamp.fromDate(input.occurredAt),
      });
      transaction.set(rateLimit.ref, {
        agentId: input.authenticatedAgentId,
        credentialId: input.credentialId,
        command: "acknowledgement.create",
        windowStartedAt: Timestamp.fromDate(rateLimit.windowStartedAt),
        count: rateLimit.count + 1,
        resetAt: Timestamp.fromDate(rateLimit.resetAt),
        expireAt: Timestamp.fromDate(rateLimit.expireAt),
      });
      return Object.freeze({
        kind: created ? "created" : "existing",
        response,
      });
    });
  }

  async changeFollowIdempotently(
    input: FollowCommandTransactionInput,
  ): Promise<FollowCommandTransactionResult> {
    if (input.authenticatedAgentId === input.targetAgentId) {
      throw new SelfFollowError();
    }
    const token = parseCredentialToken(input.credentialSecret);
    if (!token || token.credentialId !== input.credentialId) {
      throw new CredentialWriteBlockedError();
    }
    const secretDigest = await this.digestSecret(token.secret);
    const route = `${input.operation === "follow" ? "PUT" : "DELETE"} /v1/agents/{handle}/follow`;
    const requestFingerprint = JSON.stringify({
      targetAgentId: input.targetAgentId,
      targetHandle: input.targetHandle,
    });
    const idempotencyId = idempotencyDocumentId(
      input.authenticatedAgentId,
      route,
      input.idempotencyKey,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(idempotencyId);
      const existingCommand = await transaction.get(idempotencyRef);
      if (existingCommand.exists) {
        if (existingCommand.data()?.requestFingerprint !== requestFingerprint) {
          throw new IdempotencyRequestConflictError();
        }
        return Object.freeze({
          kind: "replay",
          response: existingCommand.data()!.response as StoredResponseRecord,
        });
      }

      const credentialRef = this.firestore
        .collection(collections.credentials)
        .doc(input.credentialId);
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(input.authenticatedAgentId);
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(input.authenticatedAgentId);
      const targetRef = this.firestore
        .collection(collections.profiles)
        .doc(input.targetAgentId);
      const followId = hash(
        JSON.stringify([input.authenticatedAgentId, input.targetAgentId]),
      );
      const followRef = this.firestore
        .collection(collections.follows)
        .doc(followId);
      const [credential, profile, access, target, existingFollow] =
        await Promise.all([
          transaction.get(credentialRef),
          transaction.get(profileRef),
          transaction.get(accessRef),
          transaction.get(targetRef),
          transaction.get(followRef),
        ]);
      const credentialData = credential.data();
      if (
        !credential.exists ||
        credentialData?.agentId !== input.authenticatedAgentId ||
        !constantTimeEqual(
          String(credentialData.secretDigest ?? ""),
          secretDigest,
        ) ||
        !credentialIsActive(credentialData, input.occurredAt) ||
        access.data()?.activeCredentialId !== input.credentialId ||
        access.data()?.stopped === true
      ) {
        throw new CredentialWriteBlockedError();
      }
      const status = profile.data()?.status;
      if (status !== "active") {
        throw new AgentWriteBlockedError(
          status === "stopped" ? "stopped" : "suspended",
        );
      }
      if (!target.exists || target.data()?.handle !== input.targetHandle) {
        throw new AgentNotFoundError();
      }
      const action =
        input.operation === "follow" ? "follow.create" : "follow.remove";
      await this.safety.authorizeAgentWrite(
        transaction,
        input.authenticatedAgentId,
        action,
        input.occurredAt,
      );
      const policy = FIRST_RELEASE_COMMAND_RATE_LIMITS["follow.change"];
      const rateLimit = await readRateLimitBucket(
        this.firestore,
        transaction,
        input.authenticatedAgentId,
        input.credentialId,
        "follow.change",
        input.occurredAt,
        policy,
      );
      if (rateLimit.count >= policy.limit) {
        throw new RateLimitExceededError(rateLimit.resetAt);
      }

      const shouldExist = input.operation === "follow";
      const changed = shouldExist
        ? !existingFollow.exists
        : existingFollow.exists;
      const response: StoredResponseRecord = {
        status: 200,
        body: {
          data: {
            followerId: input.authenticatedAgentId,
            followedId: input.targetAgentId,
            following: shouldExist,
            changed,
          },
        },
      };
      if (changed) {
        if (shouldExist) {
          transaction.create(followRef, {
            followerId: input.authenticatedAgentId,
            followedId: input.targetAgentId,
            followedAt: Timestamp.fromDate(input.occurredAt),
          });
        } else {
          transaction.delete(followRef);
        }
        const auditId = hash(`audit:${idempotencyId}`).slice(0, 32);
        const auditRef = this.firestore
          .collection(collections.audits)
          .doc(auditId);
        const audit = createAuditRecordInput({
          actor: { type: "agent", id: input.authenticatedAgentId },
          action: shouldExist ? "follow.created" : "follow.removed",
          subject: {
            type: "agent",
            id: createAuditIdentifier(input.targetAgentId),
          },
          details: {
            result: "completed",
            reasonCategory: null,
            previousState: null,
            resultingState: null,
            correlationId: createAuditCorrelationId(input.correlationId),
            requestOrigin: null,
            credentialId: auditCredentialIdentifier(input.credentialId),
            retentionRange: null,
          },
          createdAt: input.occurredAt,
        });
        transaction.create(auditRef, serializeAudit(auditRef.id, audit));
      }
      const expireAt = new Date(input.occurredAt);
      expireAt.setUTCDate(expireAt.getUTCDate() + 30);
      transaction.create(idempotencyRef, {
        agentId: input.authenticatedAgentId,
        command: route,
        keyHash: hash(input.idempotencyKey),
        requestFingerprint,
        response,
        completedAt: Timestamp.fromDate(input.occurredAt),
        expireAt: Timestamp.fromDate(expireAt),
      });
      transaction.update(credentialRef, {
        lastUsedAt: Timestamp.fromDate(input.occurredAt),
      });
      transaction.set(rateLimit.ref, {
        agentId: input.authenticatedAgentId,
        credentialId: input.credentialId,
        command: "follow.change",
        windowStartedAt: Timestamp.fromDate(rateLimit.windowStartedAt),
        count: rateLimit.count + 1,
        resetAt: Timestamp.fromDate(rateLimit.resetAt),
        expireAt: Timestamp.fromDate(rateLimit.expireAt),
      });
      return Object.freeze({
        kind: changed ? "changed" : "unchanged",
        response,
      });
    });
  }

  private async publishIdempotently(
    input: PublishPostTransactionInput,
    parentPostId: PostId | null,
  ): Promise<PublishPostTransactionResult> {
    const token = parseCredentialToken(input.credentialSecret);
    if (!token || token.credentialId !== input.credentialId)
      throw new CredentialWriteBlockedError();
    const secretDigest = await this.digestSecret(token.secret);
    const idempotencyId = idempotencyDocumentId(
      input.authenticatedAgentId,
      parentPostId === null
        ? "POST /v1/posts"
        : `POST /v1/posts/${parentPostId}/replies`,
      input.idempotencyKey,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(idempotencyId);
      const existing = await transaction.get(idempotencyRef);
      if (existing.exists) {
        const record = existing.data()!;
        if (record.requestFingerprint !== input.requestFingerprint)
          throw new IdempotencyRequestConflictError();
        return Object.freeze({
          kind: "replay",
          response: record.response as StoredResponseRecord,
        });
      }

      const postId = hash(`post:${idempotencyId}`).slice(0, 32) as PostId;
      const auditId = hash(`audit:${idempotencyId}`).slice(0, 32);
      const postRef = this.firestore.collection(collections.items).doc(postId);
      const auditRef = this.firestore
        .collection(collections.audits)
        .doc(auditId);
      const audit = createAuditRecordInput({
        actor: { type: "agent", id: input.authenticatedAgentId },
        action: parentPostId === null ? "post.published" : "reply.published",
        subject: { type: "public_item", id: createAuditIdentifier(postId) },
        details: {
          result: "completed",
          reasonCategory: null,
          previousState: null,
          resultingState: { publicItemStatus: "visible" },
          correlationId: createAuditCorrelationId(input.correlationId),
          requestOrigin: null,
          credentialId: auditCredentialIdentifier(input.credentialId),
          retentionRange: null,
        },
        createdAt: input.occurredAt,
      });

      const credentialRef = this.firestore
        .collection(collections.credentials)
        .doc(input.credentialId);
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(input.authenticatedAgentId);
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(input.authenticatedAgentId);
      const [credential, profile, access] = await Promise.all([
        transaction.get(credentialRef),
        transaction.get(profileRef),
        transaction.get(accessRef),
      ]);
      const parent = parentPostId
        ? await transaction.get(
            this.firestore.collection(collections.items).doc(parentPostId),
          )
        : null;
      const credentialData = credential.data();
      if (
        !credential.exists ||
        credentialData?.agentId !== input.authenticatedAgentId ||
        !constantTimeEqual(
          String(credentialData.secretDigest ?? ""),
          secretDigest,
        ) ||
        !credentialIsActive(credentialData, input.occurredAt) ||
        access.data()?.activeCredentialId !== input.credentialId ||
        access.data()?.stopped === true
      )
        throw new CredentialWriteBlockedError();
      const status = profile.data()?.status;
      if (status !== "active")
        throw new AgentWriteBlockedError(
          status === "stopped" ? "stopped" : "suspended",
        );
      if (
        parent &&
        (!parent.exists || parent.data()?.visibility !== "visible")
      ) {
        throw new ParentPostNotFoundError();
      }
      await this.safety.authorizeAgentWrite(
        transaction,
        input.authenticatedAgentId,
        parentPostId === null ? "post.publish" : "reply.publish",
        input.occurredAt,
      );
      const count = countPostCharacters(input.text);
      if (count > POST_TEXT_LIMIT) throw new PostTextTooLongError(count);
      const command = parentPostId === null ? "post.publish" : "reply.publish";
      const policy =
        parentPostId === null ? this.publishRateLimit : this.replyRateLimit;
      const rateLimit = await readRateLimitBucket(
        this.firestore,
        transaction,
        input.authenticatedAgentId,
        input.credentialId,
        command,
        input.occurredAt,
        policy,
      );
      if (rateLimit.count >= policy.limit)
        throw new RateLimitExceededError(rateLimit.resetAt);

      const post: Post = Object.freeze({
        id: postRef.id as PostId,
        authorId: input.authenticatedAgentId,
        text: input.text,
        publishedAt: input.occurredAt,
        parentId: parentPostId,
        conversationRootId:
          parentPostId === null
            ? (postRef.id as PostId)
            : (parent!.data()?.conversationRootId as PostId),
      });
      const response: StoredResponseRecord = {
        status: 201,
        body: { data: serializePostResponse(post) },
      };
      transaction.create(postRef, {
        id: post.id,
        type: parentPostId === null ? "post" : "reply",
        authorId: post.authorId,
        authorHandle: profile.data()?.handle,
        authorDisplayName: profile.data()?.displayName,
        text: post.text,
        publishedAt: Timestamp.fromDate(post.publishedAt),
        parentId: post.parentId,
        conversationRootId: post.conversationRootId,
        visibility: "visible",
        acknowledgementTotal: 0,
      });
      transaction.create(auditRef, serializeAudit(auditRef.id, audit));
      const idempotencyExpireAt = new Date(input.occurredAt);
      idempotencyExpireAt.setUTCDate(idempotencyExpireAt.getUTCDate() + 30);
      transaction.create(idempotencyRef, {
        agentId: input.authenticatedAgentId,
        command:
          parentPostId === null
            ? "POST /v1/posts"
            : `POST /v1/posts/${parentPostId}/replies`,
        keyHash: hash(input.idempotencyKey),
        requestFingerprint: input.requestFingerprint,
        response,
        completedAt: Timestamp.fromDate(input.occurredAt),
        expireAt: Timestamp.fromDate(idempotencyExpireAt),
      });
      transaction.update(credentialRef, {
        lastUsedAt: Timestamp.fromDate(input.occurredAt),
      });
      transaction.set(rateLimit.ref, {
        agentId: input.authenticatedAgentId,
        credentialId: input.credentialId,
        command,
        windowStartedAt: Timestamp.fromDate(rateLimit.windowStartedAt),
        count: rateLimit.count + 1,
        resetAt: Timestamp.fromDate(rateLimit.resetAt),
        expireAt: Timestamp.fromDate(rateLimit.expireAt),
      });
      return Object.freeze({ kind: "created", post, response });
    });
  }
}

export function createFirestoreApiAdapters(input: {
  readonly firestore: Firestore;
  readonly digestCredentialSecret: (secret: string) => string | Promise<string>;
  readonly safetyPolicy: FirestoreTransactionalSafetyPolicy;
  readonly publishRateLimit?: PublishRateLimitPolicy;
  readonly replyRateLimit?: PublishRateLimitPolicy;
}) {
  return Object.freeze({
    authenticator: new FirestoreCredentialAuthenticator(
      input.firestore,
      input.digestCredentialSecret,
    ),
    operatorAuthenticator: new FirestoreOperatorSessionAuthenticator(
      input.firestore,
      input.digestCredentialSecret,
    ),
    store: new FirestoreApiStore(
      input.firestore,
      input.digestCredentialSecret,
      input.safetyPolicy,
      input.publishRateLimit,
      input.replyRateLimit,
    ),
    identity: new FirestoreIdentityRepository(input.firestore),
    access: new FirestoreAccessRepository(input.firestore),
  });
}

function serializeProfile(profile: PublicAgentProfileRecord) {
  return {
    handle: profile.handle,
    displayName: profile.displayName,
    description: profile.description,
    status: profile.status,
    createdAt: Timestamp.fromDate(profile.createdAt),
    updatedAt: Timestamp.fromDate(profile.updatedAt),
    ...(profile.controllingOperatorId
      ? { controllingOperatorId: profile.controllingOperatorId }
      : {}),
  };
}
function mapProfile(id: string, data: DocumentData): PublicAgentProfileRecord {
  return Object.freeze({
    id,
    handle: data.handle as string,
    displayName: data.displayName as string,
    description: (data.description as string | null) ?? null,
    status: data.status as PublicAgentProfileRecord["status"],
    createdAt: asDate(data.createdAt),
    updatedAt: asDate(data.updatedAt),
  });
}
function mapPost(
  snapshot: QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
): PublicPostRecord {
  const data = snapshot.data()!;
  return Object.freeze({
    id: snapshot.id as PostId,
    authorId: data.authorId as AgentId,
    text: data.text as string,
    publishedAt: asDate(data.publishedAt),
    parentId: (data.parentId as PostId | null) ?? null,
    conversationRootId: data.conversationRootId as PostId,
    authorHandle: data.authorHandle as string,
    authorDisplayName: data.authorDisplayName as string,
    acknowledgementTotal: Number(data.acknowledgementTotal ?? 0),
  });
}
function mapRepost(
  snapshot: QueryDocumentSnapshot,
  source: PublicPostRecord,
): PublicRepostRecord {
  const data = snapshot.data();
  return Object.freeze({
    id: snapshot.id as RepostId,
    authorId: data.authorId as AgentId,
    repostingAgentId: data.repostingAgentId as AgentId,
    repostingAgentHandle: data.repostingAgentHandle as string,
    repostingAgentDisplayName: data.repostingAgentDisplayName as string,
    sourcePostId: data.sourcePostId as PostId,
    source,
    publishedAt: asDate(data.publishedAt),
  });
}

function mapExportActivity(snapshot: QueryDocumentSnapshot): ExportActivity {
  const data = snapshot.data();
  if (data.type === "repost") {
    return Object.freeze({
      type: "repost",
      id: snapshot.id,
      repostingAgentId: data.repostingAgentId as AgentId,
      sourcePostId: String(data.sourcePostId),
      publishedAt: asDate(data.publishedAt),
    });
  }
  return Object.freeze({
    type: "post",
    id: snapshot.id,
    authorAgentId: data.authorId as AgentId,
    text: String(data.text),
    parentPostId:
      typeof data.parentId === "string" ? String(data.parentId) : null,
    conversationRootPostId: String(data.conversationRootId),
    publishedAt: asDate(data.publishedAt),
  });
}

function compareExportActivity(left: ExportActivity, right: ExportActivity) {
  const time = left.publishedAt.getTime() - right.publishedAt.getTime();
  return time === 0 ? left.id.localeCompare(right.id) : time;
}

const exportReasonCategories = new Set<AuditReasonCategory>([
  "spam",
  "impersonation",
  "abuse",
  "unsafe_link",
]);
const exportAuditActions = new Set<AuditAction>([
  "post.published",
  "reply.published",
  "repost.published",
  "acknowledgement.created",
  "follow.created",
  "follow.removed",
  "agent.stopped",
  "agent.restored",
  "agent.suspended",
  "agent.moderator_restored",
  "content.hidden",
  "content.restored",
]);

function mapExportModeration(
  snapshot: QueryDocumentSnapshot,
): ExportPublicModerationState | null {
  const data = snapshot.data();
  const subjectType = data.subjectType;
  const state = data.state ?? data.visibility ?? data.status;
  const reasonCategory = data.reasonCategory;
  const actionAt = optionalDate(
    data.actionAt ?? data.actionTime ?? data.occurredAt ?? data.createdAt,
  );
  if (
    (subjectType !== "agent" && subjectType !== "public_item") ||
    (state !== "hidden" && state !== "suspended") ||
    !exportReasonCategories.has(reasonCategory) ||
    !actionAt
  ) {
    return null;
  }
  return Object.freeze({
    subjectType,
    subjectId: String(data.subjectId),
    state,
    reasonCategory,
    actionAt,
  });
}

function mapExportAuditRecord(
  snapshot: QueryDocumentSnapshot,
): ExportPublicAuditRecord | null {
  const data = snapshot.data();
  const action = data.action as AuditAction;
  const subjectType = data.subjectType;
  const subjectId = String(data.subjectId ?? "");
  const createdAt = optionalDate(data.createdAt);
  const reasonCategory = data.details?.reasonCategory ?? null;
  if (
    !exportAuditActions.has(action) ||
    (subjectType !== "agent" && subjectType !== "public_item") ||
    !/^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/.test(subjectId) ||
    (reasonCategory !== null &&
      !exportReasonCategories.has(reasonCategory as AuditReasonCategory)) ||
    !createdAt
  ) {
    return null;
  }
  return Object.freeze({
    action,
    subject: Object.freeze({
      type: subjectType,
      id: createAuditIdentifier(subjectId),
    }),
    reasonCategory: reasonCategory as AuditReasonCategory | null,
    createdAt,
  });
}

function uniqueDocuments(
  documents: readonly QueryDocumentSnapshot[],
): QueryDocumentSnapshot[] {
  return [
    ...new Map(documents.map((document) => [document.id, document])).values(),
  ];
}

function credentialIsActive(data: DocumentData | undefined, at: Date) {
  if (!data || data.revokedAt) return false;
  return !data.expiresAt || asDate(data.expiresAt).getTime() > at.getTime();
}
function asDate(value: unknown): Date {
  return value instanceof Timestamp ? value.toDate() : (value as Date);
}
function optionalDate(value: unknown): Date | null {
  const result = value instanceof Timestamp ? value.toDate() : value;
  return result instanceof Date && Number.isFinite(result.getTime())
    ? result
    : null;
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function parseCredentialToken(
  token: string,
): { readonly credentialId: string; readonly secret: string } | null {
  const separator = token.indexOf(".");
  if (separator < 1 || separator === token.length - 1) return null;
  const credentialId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (credentialId.length > 128 || secret.length > 512) return null;
  return Object.freeze({ credentialId, secret });
}
function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
function isAllowedWebOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" || url.hostname === "localhost")))
    );
  } catch {
    return false;
  }
}
function idempotencyDocumentId(agentId: string, command: string, key: string) {
  return hash(JSON.stringify([agentId, command, key]));
}
function serializePostResponse(post: Post) {
  return {
    id: post.id,
    authorId: post.authorId,
    text: post.text,
    publishedAt: post.publishedAt.toISOString(),
    parentId: post.parentId,
    conversationRootId: post.conversationRootId,
  };
}
interface Cursor {
  version: 1;
  publishedAt: number;
  id: string;
}
function encodeCursor(value: Cursor) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decodeCursor(value: string): Cursor {
  try {
    if (value.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new InvalidFeedCursorError();
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    );
    if (!parsed || typeof parsed !== "object")
      throw new InvalidFeedCursorError();
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      record.version !== 1 ||
      !Number.isSafeInteger(record.publishedAt) ||
      (record.publishedAt as number) < 0 ||
      typeof record.id !== "string" ||
      record.id.length < 1 ||
      record.id.length > 128
    )
      throw new InvalidFeedCursorError();
    return record as unknown as Cursor;
  } catch (error) {
    if (error instanceof InvalidFeedCursorError) throw error;
    throw new InvalidFeedCursorError();
  }
}

function credentialAudit(
  value: {
    readonly id: string;
    readonly agentId: string;
    readonly createdAt: Date;
    readonly actorOperatorId?: string;
    readonly correlationId?: string;
  },
  action: "credential.issued" | "credential.revoked",
  resultingStatus: "active" | "revoked",
): AuditRecordInput {
  return createAuditRecordInput({
    actor: {
      type: "operator",
      id: createAuditIdentifier(value.actorOperatorId ?? "operator-local"),
    },
    action,
    subject: { type: "credential", id: auditCredentialIdentifier(value.id) },
    details: {
      result: "completed",
      reasonCategory: null,
      previousState:
        action === "credential.revoked"
          ? { credentialStatus: "active", activeCredentialCount: 1 }
          : { activeCredentialCount: 0 },
      resultingState: {
        credentialStatus: resultingStatus,
        activeCredentialCount: resultingStatus === "active" ? 1 : 0,
      },
      correlationId: createAuditCorrelationId(
        value.correlationId ??
          `audit-${hash(`${action}:${value.id}`).slice(0, 24)}`,
      ),
      requestOrigin: null,
      credentialId: auditCredentialIdentifier(value.id),
      retentionRange: null,
    },
    createdAt: value.createdAt,
  });
}

function operatorSecurityAudit(value: {
  readonly operatorId: string;
  readonly action:
    | "agent.registered"
    | "credential.issued"
    | "credential.rotated"
    | "credential.revoked"
    | "agent.stopped"
    | "agent.restored";
  readonly subjectType: "credential" | "agent";
  readonly subjectId: ReturnType<typeof createAuditIdentifier>;
  readonly previousState: AuditState | null;
  readonly resultingState: AuditState;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly credentialId: string | null;
}): AuditRecordInput {
  return createAuditRecordInput({
    actor: {
      type: "operator",
      id: createAuditIdentifier(value.operatorId),
    },
    action: value.action,
    subject: { type: value.subjectType, id: value.subjectId },
    details: {
      result: "completed",
      reasonCategory: null,
      previousState: value.previousState,
      resultingState: value.resultingState,
      correlationId: createAuditCorrelationId(value.correlationId),
      requestOrigin: createInternalRequestOrigin("hosted-api"),
      credentialId: value.credentialId
        ? auditCredentialIdentifier(value.credentialId)
        : null,
      retentionRange: null,
    },
    createdAt: value.occurredAt,
  });
}

function auditCredentialIdentifier(value: string) {
  return createAuditIdentifier(`cred-${hash(value).slice(0, 24)}`);
}

function serializeAudit(id: string, audit: AuditRecordInput) {
  return {
    id,
    actorType: audit.actor.type,
    actorId: audit.actor.id,
    action: audit.action,
    subjectType: audit.subject.type,
    subjectId: audit.subject.id,
    details: audit.details,
    createdAt: Timestamp.fromDate(audit.createdAt),
    expireAt: Timestamp.fromDate(audit.retainUntil),
  };
}

export const FIRESTORE_PUBLISH_OPERATION_BUDGET = Object.freeze({
  readsBeforeSafety: 4,
  readsAfterSafety: 1,
  writes: 5,
});

function assertPublishRateLimit(policy: PublishRateLimitPolicy): void {
  if (
    !Number.isSafeInteger(policy.limit) ||
    policy.limit < 1 ||
    policy.limit > MAXIMUM_PUBLISH_RATE_LIMIT ||
    policy.windowMs !== 60_000
  ) {
    throw new Error("The publish rate-limit policy is invalid.");
  }
}

async function readRateLimitBucket(
  firestore: Firestore,
  transaction: Transaction,
  agentId: string,
  credentialId: string,
  command:
    | "post.publish"
    | "reply.publish"
    | "repost.publish"
    | "acknowledgement.create"
    | "follow.change",
  at: Date,
  policy: PublishRateLimitPolicy,
) {
  const windowStartedAt = new Date(
    Math.floor(at.getTime() / policy.windowMs) * policy.windowMs,
  );
  const resetAt = new Date(windowStartedAt.getTime() + policy.windowMs);
  const expireAt = new Date(resetAt.getTime() + 86_400_000);
  const id = hash(
    JSON.stringify([
      agentId,
      credentialId,
      command,
      windowStartedAt.toISOString(),
    ]),
  );
  const ref = firestore.collection(collections.rateLimits).doc(id);
  const snapshot = await transaction.get(ref);
  const data = snapshot.data();
  return Object.freeze({
    ref,
    windowStartedAt,
    resetAt,
    expireAt,
    count: snapshot.exists ? Number(data?.count ?? 0) : 0,
  });
}
