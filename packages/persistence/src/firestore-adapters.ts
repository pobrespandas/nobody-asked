import { createHash, timingSafeEqual } from "node:crypto";

import {
  createAuditCorrelationId,
  createAuditIdentifier,
  createAuditRecordInput,
  type AuditRecordInput,
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
  StoredResponseRecord,
} from "./contracts.js";
import {
  AgentWriteBlockedError,
  AgentNotFoundError,
  CredentialWriteBlockedError,
  IdempotencyRequestConflictError,
  RateLimitExceededError,
  ParentPostNotFoundError,
} from "./contracts.js";

const collections = {
  profiles: "agentProfiles",
  handles: "handleClaims",
  credentials: "credentials",
  access: "agentAccess",
  items: "publicItems",
  follows: "follows",
  audits: "auditRecords",
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
function credentialIsActive(data: DocumentData | undefined, at: Date) {
  if (!data || data.revokedAt) return false;
  return !data.expiresAt || asDate(data.expiresAt).getTime() > at.getTime();
}
function asDate(value: unknown): Date {
  return value instanceof Timestamp ? value.toDate() : (value as Date);
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
    "post.publish" | "reply.publish" | "repost.publish" | "follow.change",
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
