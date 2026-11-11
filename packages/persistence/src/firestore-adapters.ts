import { createHash, timingSafeEqual } from "node:crypto";
import {
  FirestoreOperatorAuthorizations,
  authorityRevision,
  readAuthorityRemoval,
  writeAuthorityRemoval,
  readAuthorizationRate,
} from "./operator-authorizations.js";
import type {
  AgentOperatorAuthorizationAuthentication,
  CreateAgentOperatorAuthorizationInput,
  RemoveAgentOperatorAuthorizationInput,
  AcceptAgentOperatorAuthorizationInput,
} from "./contracts.js";

import {
  AgentProofRejectedError,
  decideAgentRegistrationStart,
  agentRecoveryInputFingerprint,
  assertInvitationEnrollment,
  assertOperatorAuthentication,
  consumeAgentRegistration,
  consumeAgentRecovery,
  createAgentRecoveryChallenge,
  createAgentRegistrationAttempt,
  createOperatorSession,
  OperatorAuthenticationRejectedError,
  OperatorEnrollmentRejectedError,
  UnsafeOperatorSecretDigestError,
  type OperatorSessionRecord,
  type AgentRecoveryOperation,
  type Ed25519PublicJwk,
  validateAgentRecoveryKey,
} from "@nobody-asked/access";
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
import {
  isModerationReasonCategory,
  isReportReviewDecision,
  moderationAgentTransition,
  moderationContentTransition,
} from "@nobody-asked/safety";

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
  OperatorEnrollmentCommandInput,
  OperatorInvitationCreationInput,
  OperatorChallengeCreationInput,
  OperatorSessionCommandInput,
  OperatorSessionCommandResult,
  OperatorSessionRevocationInput,
  OperatorPortableExportInput,
  OperatorPortableExport,
  RegisterOperatorAgentInput,
  RegisterOperatorAgentResult,
  StartAgentRegistrationInput,
  CompleteAgentRegistrationInput,
  CompleteAgentRegistrationResult,
  StartAgentRecoveryInput,
  CompleteAgentRecoveryInput,
  CompleteAgentRecoveryResult,
  StoredResponseRecord,
  SubmitReportTransactionInput,
  ReviewReportTransactionInput,
  ReportRecord,
  ReportTargetRecord,
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
  ModeratorAuthorityDeniedError,
  ReportAlreadyResolvedError,
  ReportNotFoundError,
  ReportTargetNotFoundError,
  InvalidReportReviewDecisionError,
} from "./contracts.js";
import {
  registrationControl,
  reserveRegistrationLease,
} from "./registration-controls.js";

const collections = {
  profiles: "agentProfiles",
  handles: "handleClaims",
  credentials: "credentials",
  access: "agentAccess",
  operators: "operators",
  operatorInvitations: "operatorInvitations",
  operatorChallenges: "operatorChallenges",
  moderatorAuthorities: "moderatorAuthorities",
  operatorSessions: "operatorSessions",
  agentRegistrations: "agentRegistrations",
  recoveryKeys: "agentRecoveryKeys",
  recoveryChallenges: "agentRecoveryChallenges",
  items: "publicItems",
  follows: "follows",
  acknowledgements: "acknowledgements",
  audits: "auditRecords",
  moderationActions: "moderationActions",
  idempotency: "idempotencyRecords",
  rateLimits: "rateLimitBuckets",
  reports: "reports",
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
      | "follow.remove"
      | "report.create",
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

  createBootstrapOperatorInvitation(input: {
    readonly id: string;
    readonly intendedIdentity: string;
    readonly secretDigest: string;
    readonly issuedAt: Date;
    readonly expiresAt: Date;
    readonly correlationId: string;
  }): Promise<void> {
    return this.firestore.runTransaction(async (transaction) => {
      const invitationRef = this.firestore
        .collection(collections.operatorInvitations)
        .doc(input.id);
      if ((await transaction.get(invitationRef)).exists)
        throw new IdempotencyRequestConflictError();
      transaction.create(invitationRef, {
        intendedIdentity: input.intendedIdentity,
        secretDigest: input.secretDigest,
        issuerOperatorId: null,
        issuedAt: Timestamp.fromDate(input.issuedAt),
        expiresAt: Timestamp.fromDate(input.expiresAt),
        recipientProofAt: null,
        acceptedAt: null,
        acceptedOperatorId: null,
        revokedAt: null,
      });
      writeOperatorAudit(
        this.firestore,
        transaction,
        "operator.invitation_created",
        { type: "system", id: "deployment-bootstrap" },
        input.id,
        input.issuedAt,
        input.correlationId,
      );
    });
  }

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
    return Object.freeze(await this.mapTimelineRecords(snapshot.docs));
  }

  async findVisiblePublicPostById(
    id: string,
  ): Promise<PublicPostRecord | null> {
    const snapshot = await this.firestore
      .collection(collections.items)
      .doc(id)
      .get();
    return snapshot.exists &&
      (snapshot.data()?.visibility === "visible" ||
        !!snapshot.data()?.deletedAt) &&
      snapshot.data()?.type !== "repost"
      ? await this.readPostWithCounts(snapshot)
      : null;
  }

  async listVisibleConversation(
    rootId: string,
  ): Promise<readonly PublicPostRecord[]> {
    const snapshot = await this.firestore
      .collection(collections.items)
      .where("conversationRootId", "==", rootId)
      .where("visibility", "in", ["visible", "deleted"])
      .orderBy("publishedAt", "asc")
      .orderBy("id", "asc")
      .limit(100)
      .get();
    return Object.freeze(
      await Promise.all(
        snapshot.docs
          .filter(
            (doc) =>
              doc.data().visibility === "visible" || doc.data().deletedAt,
          )
          .map((doc) => this.readPostWithCounts(doc)),
      ),
    );
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
    return Object.freeze(await this.mapTimelineRecords(snapshot.docs));
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
    readonly parentId?: string;
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
    if (options.parentId !== undefined)
      query = query.where("parentId", "==", options.parentId);
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
      items: Object.freeze(await this.mapTimelineRecords(docs)),
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
    for (const batch of chunks(ordered, options.limit + 1)) {
      visible.push(...(await this.mapTimelineRecords(batch)));
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

  private async mapTimelineRecords(
    snapshots: readonly QueryDocumentSnapshot[],
  ): Promise<PublicTimelineRecord[]> {
    const publicPosts = new Map<string, Promise<PublicPostRecord>>();
    const readPost = (snapshot: FirebaseFirestore.DocumentSnapshot) => {
      let post = publicPosts.get(snapshot.id);
      if (!post) {
        post = this.readPostWithCounts(snapshot);
        publicPosts.set(snapshot.id, post);
      }
      return post;
    };
    const sourceIds = [
      ...new Set(
        snapshots
          .filter((snapshot) => snapshot.data().type === "repost")
          .map((snapshot) => String(snapshot.data().sourcePostId)),
      ),
    ];
    const sources = new Map<string, PublicPostRecord>();
    if (sourceIds.length) {
      const documents = await this.firestore.getAll(
        ...sourceIds.map((id) =>
          this.firestore.collection(collections.items).doc(id),
        ),
      );
      await Promise.all(
        documents.map(async (document) => {
          const data = document.data();
          if (
            document.exists &&
            data?.visibility === "visible" &&
            data.type !== "repost"
          ) {
            sources.set(document.id, await readPost(document));
          }
        }),
      );
    }
    const records = await Promise.all(
      snapshots.map(async (snapshot): Promise<PublicTimelineRecord | null> => {
        const data = snapshot.data();
        if (data.type !== "repost") {
          return readPost(snapshot);
        } else {
          const source = sources.get(String(data.sourcePostId));
          return source ? mapRepost(snapshot, source) : null;
        }
      }),
    );
    return records.filter(
      (record): record is PublicTimelineRecord => record !== null,
    );
  }

  private async readPostWithCounts(
    snapshot: FirebaseFirestore.DocumentSnapshot,
  ): Promise<PublicPostRecord> {
    const items = this.firestore.collection(collections.items);
    const [replies, reposts] = await Promise.all([
      items
        .where("parentId", "==", snapshot.id)
        .where("visibility", "==", "visible")
        .count()
        .get(),
      items
        .where("sourcePostId", "==", snapshot.id)
        .where("visibility", "==", "visible")
        .count()
        .get(),
    ]);
    return mapPost(snapshot, replies.data().count, reposts.data().count);
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
  private operatorAuthorizations() {
    return new FirestoreOperatorAuthorizations(
      this.firestore,
      this.digestSecret,
      (transaction, event) => {
        const audit = createAuditRecordInput({
          actor: event.operator
            ? { type: "operator", id: createAuditIdentifier(event.actorId) }
            : { type: "agent", id: event.actorId as AgentId },
          action: event.action,
          subject: { type: "agent", id: createAuditIdentifier(event.agentId) },
          details: {
            result: "completed",
            reasonCategory: null,
            previousState: null,
            resultingState: null,
            correlationId: createAuditCorrelationId(event.correlationId),
            requestOrigin: createInternalRequestOrigin("hosted-api"),
            credentialId: null,
            retentionRange: null,
          },
          createdAt: event.at,
        });
        const ref = this.firestore.collection(collections.audits).doc();
        transaction.create(ref, serializeAudit(ref.id, audit));
      },
    );
  }
  readAgentOperatorAuthorization(
    input: AgentOperatorAuthorizationAuthentication,
  ) {
    return this.operatorAuthorizations().read(input);
  }
  createAgentOperatorAuthorizationIdempotently(
    input: CreateAgentOperatorAuthorizationInput,
  ) {
    return this.operatorAuthorizations().create(input);
  }
  removeAgentOperatorAuthorizationIdempotently(
    input: RemoveAgentOperatorAuthorizationInput,
  ) {
    return this.operatorAuthorizations().remove(input);
  }
  acceptAgentOperatorAuthorizationIdempotently(
    input: AcceptAgentOperatorAuthorizationInput,
  ) {
    return this.operatorAuthorizations().accept(input);
  }
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

  async startAgentRegistration(
    input: StartAgentRegistrationInput,
  ): Promise<Readonly<{ created: boolean; expiresAt: Date }>> {
    const attempt = createAgentRegistrationAttempt({
      id: input.registrationId,
      inputFingerprint: input.inputFingerprint,
      recoveryPublicKey: input.recoveryPublicKey,
      challenge: input.challenge,
      createdAt: input.createdAt,
    });
    const challengeDigest = await this.digestSecret(input.challenge);
    if (!challengeDigest || challengeDigest === input.challenge) {
      throw new AgentProofRejectedError();
    }
    const normalizedHandle = input.handle
      .trim()
      .normalize("NFKC")
      .toLowerCase();
    return this.firestore.runTransaction(async (transaction) => {
      const registrationRef = this.firestore
        .collection(collections.agentRegistrations)
        .doc(input.registrationId);
      const existing = await transaction.get(registrationRef);
      if (existing.exists) {
        if (existing.data()?.inputFingerprint !== input.inputFingerprint) {
          throw new IdempotencyRequestConflictError();
        }
        return Object.freeze({
          created: false,
          expiresAt: asDate(existing.data()?.expiresAt),
        });
      }
      const sourceHash = hash(input.networkSourceKey ?? "unknown");
      const globalRef = this.firestore
        .collection("registrationControls")
        .doc("global");
      const sourceRef = this.firestore
        .collection("registrationControls")
        .doc(`source-${sourceHash}`);
      const [globalSnapshot, sourceSnapshot] = await Promise.all([
        transaction.get(globalRef),
        transaction.get(sourceRef),
      ]);
      const circuitOpen = globalSnapshot.data()?.circuitOpen;
      if (circuitOpen !== undefined && typeof circuitOpen !== "boolean") {
        throw Object.assign(new Error("Agent registration is closed."), {
          code: "registration_circuit_open",
          retryAt: null,
        });
      }
      const global = registrationControl(
        globalSnapshot.data(),
        input.createdAt,
      );
      const source = registrationControl(
        sourceSnapshot.data(),
        input.createdAt,
      );
      const decision = decideAgentRegistrationStart({
        at: input.createdAt,
        state: {
          global: global.bucket,
          networkSource: source.bucket,
          incompleteGlobal: global.pending.length,
          incompleteForNetworkSource: source.pending.length,
          circuitBreaker:
            circuitOpen === true
              ? { state: "open", openedAt: input.createdAt, reason: "incident" }
              : { state: "closed" },
        },
      });
      if (!decision.allowed)
        throw Object.assign(new Error("Agent registration is limited."), {
          code: decision.code,
          retryAt: decision.retryAt,
        });
      for (const [ref, control] of [
        [globalRef, global],
        [sourceRef, source],
      ] as const)
        transaction.set(
          ref,
          reserveRegistrationLease(
            control,
            input.registrationId,
            decision.challengeExpiresAt,
            ref === sourceRef,
          ),
          { merge: true },
        );
      transaction.create(registrationRef, {
        networkSourceHash: sourceHash,
        handle: normalizedHandle,
        displayName: input.displayName,
        description: input.description,
        inputFingerprint: input.inputFingerprint,
        recoveryPublicKey: attempt.recoveryPublicKey,
        challengeDigest,
        createdAt: Timestamp.fromDate(attempt.createdAt),
        expiresAt: Timestamp.fromDate(attempt.expiresAt),
        consumedAt: null,
        agentId: null,
        credentialId: null,
      });
      return Object.freeze({ created: true, expiresAt: attempt.expiresAt });
    });
  }

  async completeAgentRegistration(
    input: CompleteAgentRegistrationInput,
  ): Promise<CompleteAgentRegistrationResult> {
    const challengeDigest = await this.digestSecret(input.challenge);
    const registrationRef = this.firestore
      .collection(collections.agentRegistrations)
      .doc(input.registrationId);
    const agentId = hash(`agent-registration:${input.registrationId}`).slice(
      0,
      32,
    );
    const credentialId = hash(
      `agent-registration-credential:${input.registrationId}`,
    ).slice(0, 32);

    return this.firestore.runTransaction(async (transaction) => {
      const registrationSnapshot = await transaction.get(registrationRef);
      const data = registrationSnapshot.data();
      if (
        !registrationSnapshot.exists ||
        !data ||
        !challengeDigest ||
        !constantTimeEqual(String(data.challengeDigest ?? ""), challengeDigest)
      ) {
        throw new AgentProofRejectedError();
      }
      const proofAttempt = createAgentRegistrationAttempt({
        id: input.registrationId,
        inputFingerprint: String(data.inputFingerprint),
        recoveryPublicKey: data.recoveryPublicKey as Ed25519PublicJwk,
        challenge: input.challenge,
        createdAt: asDate(data.createdAt),
      });
      const storedAttempt = {
        ...proofAttempt,
        expiresAt: asDate(data.expiresAt),
        consumedAt: null,
      };
      const completedAt = optionalDate(data.consumedAt);
      consumeAgentRegistration({
        attempt: storedAttempt,
        signature: input.signature,
        at: completedAt ?? input.occurredAt,
      });
      const registration = Object.freeze({
        agentId,
        credentialId,
        handle: String(data.handle),
        displayName: String(data.displayName),
        description: (data.description as string | null) ?? null,
        status: "active" as const,
        createdAt: completedAt ?? input.occurredAt,
      });
      if (completedAt) {
        return Object.freeze({ kind: "replay" as const, registration });
      }

      const controlRefs = data.networkSourceHash
        ? [
            this.firestore.collection("registrationControls").doc("global"),
            this.firestore
              .collection("registrationControls")
              .doc(`source-${String(data.networkSourceHash)}`),
          ]
        : [];
      const controls = await Promise.all(
        controlRefs.map((ref) => transaction.get(ref)),
      );

      const handleRef = this.firestore
        .collection(collections.handles)
        .doc(registration.handle);
      if ((await transaction.get(handleRef)).exists) {
        throw new HandleAlreadyTakenError();
      }
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(agentId);
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(agentId);
      const credentialRef = this.firestore
        .collection(collections.credentials)
        .doc(credentialId);
      const recoveryKeyRef = this.firestore
        .collection(collections.recoveryKeys)
        .doc(agentId);
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(hash(`agent-registration:${input.registrationId}`).slice(0, 32));
      const registrationAuditRef = this.firestore
        .collection(collections.audits)
        .doc(
          hash(`audit:agent-registration:${input.registrationId}`).slice(0, 32),
        );
      const credentialAuditRef = this.firestore
        .collection(collections.audits)
        .doc(
          hash(`audit:agent-credential:${input.registrationId}`).slice(0, 32),
        );

      transaction.create(handleRef, {
        agentId,
        normalizedHandle: registration.handle,
      });
      transaction.create(
        profileRef,
        serializeProfile({
          id: agentId,
          handle: registration.handle,
          displayName: registration.displayName,
          description: registration.description,
          status: registration.status,
          createdAt: registration.createdAt,
          updatedAt: registration.createdAt,
        }),
      );
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
      transaction.create(recoveryKeyRef, {
        revision: 1,
        publicKey: data.recoveryPublicKey,
        createdAt: Timestamp.fromDate(input.occurredAt),
        replacedAt: null,
        revokedAt: null,
      });
      transaction.create(
        registrationAuditRef,
        serializeAudit(
          registrationAuditRef.id,
          agentSecurityAudit({
            agentId,
            action: "agent.registered",
            subjectType: "agent",
            subjectId: createAuditIdentifier(agentId),
            previousState: null,
            resultingState: { agentStatus: "active" },
            occurredAt: input.occurredAt,
            correlationId: input.correlationId,
            credentialId: null,
          }),
        ),
      );
      transaction.create(
        credentialAuditRef,
        serializeAudit(
          credentialAuditRef.id,
          agentSecurityAudit({
            agentId,
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
          }),
        ),
      );
      const expireAt = new Date(input.occurredAt);
      expireAt.setUTCDate(expireAt.getUTCDate() + 30);
      transaction.create(idempotencyRef, {
        actorId: agentId,
        command: "POST /v1/agent-registrations/{registrationId}/complete",
        requestFingerprint: data.inputFingerprint,
        agentId,
        credentialId,
        completedAt: Timestamp.fromDate(input.occurredAt),
        expireAt: Timestamp.fromDate(expireAt),
      });
      transaction.update(registrationRef, {
        consumedAt: Timestamp.fromDate(input.occurredAt),
        agentId,
        credentialId,
      });
      controls.forEach((snapshot, index) =>
        transaction.set(
          controlRefs[index]!,
          {
            pending: registrationControl(
              snapshot.data(),
              input.occurredAt,
            ).pending.filter((entry) => entry.id !== input.registrationId),
          },
          { merge: true },
        ),
      );
      return Object.freeze({ kind: "created" as const, registration });
    });
  }

  async startAgentRecovery(input: StartAgentRecoveryInput): Promise<
    Readonly<{
      created: boolean;
      expiresAt: Date;
      authorizationRevision?: number;
    }>
  > {
    const challenge = createAgentRecoveryChallenge({
      id: input.challengeId,
      agentId: input.agentId,
      operation: input.operation,
      inputFingerprint: input.inputFingerprint,
      challenge: input.challenge,
      createdAt: input.createdAt,
    });
    if (
      input.operation !== "replace_recovery_key" &&
      input.operation !== "remove_operator_authorization" &&
      agentRecoveryInputFingerprint(input.operation) !== input.inputFingerprint
    ) {
      throw new AgentProofRejectedError();
    }
    const challengeDigest = await this.digestSecret(input.challenge);
    if (!challengeDigest || challengeDigest === input.challenge) {
      throw new AgentProofRejectedError();
    }
    return this.firestore.runTransaction(async (transaction) => {
      const challengeRef = this.firestore
        .collection(collections.recoveryChallenges)
        .doc(input.challengeId);
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(input.agentId);
      const recoveryKeyRef = this.firestore
        .collection(collections.recoveryKeys)
        .doc(input.agentId);
      const [existing, profile, recoveryKey, authority] = await Promise.all([
        transaction.get(challengeRef),
        transaction.get(profileRef),
        transaction.get(recoveryKeyRef),
        transaction.get(
          this.firestore
            .collection("agentOperatorAuthority")
            .doc(input.agentId),
        ),
      ]);
      const authorizationRevision =
        input.operation === "remove_operator_authorization"
          ? Number(
              existing.exists
                ? existing.data()!.authorizationRevision
                : authorityRevision(authority.data()),
            )
          : undefined;
      const inputFingerprint =
        input.operation === "remove_operator_authorization"
          ? agentRecoveryInputFingerprint(
              input.operation,
              undefined,
              authorizationRevision,
            )
          : input.inputFingerprint;
      if (existing.exists) {
        const data = existing.data()!;
        if (
          data.agentId !== input.agentId ||
          data.operation !== input.operation ||
          data.inputFingerprint !== inputFingerprint ||
          data.idempotencyKeyHash !== hash(input.idempotencyKey)
        ) {
          throw new IdempotencyRequestConflictError();
        }
        return Object.freeze({
          created: false,
          expiresAt: asDate(data.expiresAt),
          ...(authorizationRevision === undefined
            ? {}
            : { authorizationRevision }),
        });
      }
      if (!profile.exists) throw new AgentNotFoundError();
      const status = profile.data()?.status;
      if (
        status !== "active" &&
        !(
          input.operation === "remove_operator_authorization" &&
          (status === "stopped" || status === "suspended")
        )
      ) {
        throw new AgentWriteBlockedError(
          status === "suspended" ? "suspended" : "stopped",
        );
      }
      if (!recoveryKey.exists || recoveryKey.data()?.revokedAt) {
        throw new AgentProofRejectedError();
      }
      transaction.create(challengeRef, {
        agentId: input.agentId,
        operation: input.operation,
        inputFingerprint,
        ...(authorizationRevision === undefined
          ? {}
          : { authorizationRevision }),
        idempotencyKeyHash: hash(input.idempotencyKey),
        challengeDigest,
        createdAt: Timestamp.fromDate(challenge.createdAt),
        expiresAt: Timestamp.fromDate(challenge.expiresAt),
        consumedAt: null,
        completionIdempotencyId: null,
        recoveryKeyRevision: Number(recoveryKey.data()!.revision ?? 1),
        recoveryPublicKey: recoveryKey.data()!.publicKey,
      });
      return Object.freeze({
        created: true,
        expiresAt: challenge.expiresAt,
        ...(authorizationRevision === undefined
          ? {}
          : { authorizationRevision }),
      });
    });
  }

  async completeAgentRecovery(
    input: CompleteAgentRecoveryInput,
  ): Promise<CompleteAgentRecoveryResult> {
    const challengeDigest = await this.digestSecret(input.challenge);
    const requestFingerprint = agentRecoveryInputFingerprint(
      input.operation,
      input.recoveryPublicKey,
      input.authorizationRevision,
    );
    if (requestFingerprint !== input.inputFingerprint) {
      throw new AgentProofRejectedError();
    }
    if (
      input.operation === "replace_credential" &&
      (!input.credentialId || !input.credentialSecretDigest)
    ) {
      throw new TypeError("Credential replacement data is required.");
    }
    const idempotencyId = idempotencyDocumentId(
      input.agentId,
      `POST /v1/agents/{agentId}/recovery-challenges/{challengeId}/complete:${input.operation}`,
      input.idempotencyKey,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const challengeRef = this.firestore
        .collection(collections.recoveryChallenges)
        .doc(input.challengeId);
      const profileRef = this.firestore
        .collection(collections.profiles)
        .doc(input.agentId);
      const accessRef = this.firestore
        .collection(collections.access)
        .doc(input.agentId);
      const recoveryKeyRef = this.firestore
        .collection(collections.recoveryKeys)
        .doc(input.agentId);
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(idempotencyId);
      const credentialsQuery = this.firestore
        .collection(collections.credentials)
        .where("agentId", "==", input.agentId);
      const [
        challengeSnapshot,
        profile,
        access,
        recoveryKey,
        existing,
        credentials,
      ] = await Promise.all([
        transaction.get(challengeRef),
        transaction.get(profileRef),
        transaction.get(accessRef),
        transaction.get(recoveryKeyRef),
        transaction.get(idempotencyRef),
        transaction.get(credentialsQuery),
      ]);
      const data = challengeSnapshot.data();
      if (
        !challengeSnapshot.exists ||
        !data ||
        data.agentId !== input.agentId ||
        data.operation !== input.operation ||
        data.inputFingerprint !== input.inputFingerprint ||
        !challengeDigest ||
        !constantTimeEqual(
          String(data.challengeDigest ?? ""),
          challengeDigest,
        ) ||
        !profile.exists ||
        !recoveryKey.exists ||
        recoveryKey.data()?.revokedAt
      ) {
        throw new AgentProofRejectedError();
      }
      const completedAt = optionalDate(data.consumedAt);
      const proof = createAgentRecoveryChallenge({
        id: input.challengeId,
        agentId: input.agentId,
        operation: input.operation,
        inputFingerprint: input.inputFingerprint,
        challenge: input.challenge,
        createdAt: asDate(data.createdAt),
      });
      consumeAgentRecovery({
        recoveryPublicKey: data.recoveryPublicKey as Ed25519PublicJwk,
        challenge: {
          ...proof,
          expiresAt: asDate(data.expiresAt),
          consumedAt: null,
        },
        signature: input.signature,
        at: completedAt ?? input.occurredAt,
      });
      if (existing.exists) {
        if (existing.data()?.requestFingerprint !== requestFingerprint) {
          throw new IdempotencyRequestConflictError();
        }
        return mapAgentRecoveryResult(existing.data()!);
      }
      if (completedAt) throw new AgentProofRejectedError();
      if (
        Number(data.recoveryKeyRevision ?? 1) !==
          Number(recoveryKey.data()!.revision ?? 1) ||
        agentRecoveryInputFingerprint(
          "replace_recovery_key",
          data.recoveryPublicKey as Ed25519PublicJwk,
        ) !==
          agentRecoveryInputFingerprint(
            "replace_recovery_key",
            recoveryKey.data()!.publicKey as Ed25519PublicJwk,
          )
      ) {
        throw new AgentProofRejectedError();
      }
      const status = profile.data()?.status;
      if (
        status !== "active" &&
        !(
          input.operation === "remove_operator_authorization" &&
          (status === "stopped" || status === "suspended")
        )
      ) {
        throw new AgentWriteBlockedError(
          status === "suspended" ? "suspended" : "stopped",
        );
      }
      const activeCredentials = credentials.docs.filter((credential) =>
        credentialIsActive(credential.data(), input.occurredAt),
      );
      let credentialId: string | null = null;
      let resultingStatus: "active" | "stopped" | "suspended" = "active";
      let authorizationRevision: number | undefined;
      let audit: AuditRecordInput;
      if (input.operation === "remove_operator_authorization") {
        const state = await readAuthorityRemoval(
          this.firestore,
          transaction,
          input.agentId,
        );
        if (
          authorityRevision(state.value) !== input.authorizationRevision ||
          data.authorizationRevision !== input.authorizationRevision ||
          (!state.value && profile.data()?.controllingOperatorId)
        )
          throw new AgentProofRejectedError();
        const rate = await readAuthorizationRate(
          this.firestore,
          transaction,
          input.agentId,
          "remove",
          input.occurredAt,
        );
        authorizationRevision = writeAuthorityRemoval(
          transaction,
          state,
          input.agentId,
          input.occurredAt,
        );
        transaction.set(rate.ref, rate.data);
        resultingStatus = status as "active" | "stopped" | "suspended";
        audit = agentRecoveryAudit({
          agentId: input.agentId,
          action: "operator.authorization_removed",
          subjectType: "agent",
          subjectId: createAuditIdentifier(input.agentId),
          previousState: { agentStatus: resultingStatus },
          resultingState: { agentStatus: resultingStatus },
          occurredAt: input.occurredAt,
          correlationId: input.correlationId,
          credentialId: null,
        });
      } else if (input.operation === "replace_credential") {
        credentialId = input.credentialId!;
        const credentialRef = this.firestore
          .collection(collections.credentials)
          .doc(credentialId);
        if ((await transaction.get(credentialRef)).exists) {
          throw new ActiveCredentialExistsError();
        }
        for (const credential of activeCredentials) {
          transaction.update(credential.ref, {
            revokedAt: Timestamp.fromDate(input.occurredAt),
          });
        }
        transaction.create(credentialRef, {
          agentId: input.agentId,
          secretDigest: input.credentialSecretDigest,
          createdAt: Timestamp.fromDate(input.occurredAt),
          lastUsedAt: null,
          expiresAt: null,
          revokedAt: null,
        });
        transaction.set(
          accessRef,
          { activeCredentialId: credentialId, stopped: false },
          { merge: true },
        );
        audit = agentRecoveryAudit({
          agentId: input.agentId,
          action: "credential.rotated",
          subjectType: "credential",
          subjectId: auditCredentialIdentifier(credentialId),
          previousState: { activeCredentialCount: activeCredentials.length },
          resultingState: {
            credentialStatus: "active",
            activeCredentialCount: 1,
          },
          occurredAt: input.occurredAt,
          correlationId: input.correlationId,
          credentialId,
        });
      } else if (input.operation === "replace_recovery_key") {
        const publicKey = validateAgentRecoveryKey(input.recoveryPublicKey!);
        transaction.update(recoveryKeyRef, {
          revision: Number(recoveryKey.data()!.revision ?? 1) + 1,
          publicKey,
          replacedAt: Timestamp.fromDate(input.occurredAt),
          createdAt: Timestamp.fromDate(input.occurredAt),
          revokedAt: null,
        });
        audit = agentRecoveryAudit({
          agentId: input.agentId,
          action: "recovery_key.replaced",
          subjectType: "recovery_key",
          subjectId: createAuditIdentifier(input.agentId),
          previousState: null,
          resultingState: { agentStatus: "active" },
          occurredAt: input.occurredAt,
          correlationId: input.correlationId,
          credentialId: null,
        });
      } else {
        resultingStatus = "stopped";
        for (const credential of activeCredentials) {
          transaction.update(credential.ref, {
            revokedAt: Timestamp.fromDate(input.occurredAt),
          });
        }
        transaction.update(profileRef, {
          status: "stopped",
          updatedAt: Timestamp.fromDate(input.occurredAt),
        });
        transaction.set(
          accessRef,
          { activeCredentialId: null, stopped: true },
          { merge: true },
        );
        audit = agentRecoveryAudit({
          agentId: input.agentId,
          action: "agent.stopped",
          subjectType: "agent",
          subjectId: createAuditIdentifier(input.agentId),
          previousState: {
            agentStatus: "active",
            activeCredentialCount: activeCredentials.length,
          },
          resultingState: {
            agentStatus: "stopped",
            activeCredentialCount: 0,
          },
          occurredAt: input.occurredAt,
          correlationId: input.correlationId,
          credentialId: null,
        });
      }
      const auditRef = this.firestore
        .collection(collections.audits)
        .doc(hash(`audit:agent-recovery:${idempotencyId}`).slice(0, 32));
      transaction.create(auditRef, serializeAudit(auditRef.id, audit));
      const expireAt = new Date(input.occurredAt);
      expireAt.setUTCDate(expireAt.getUTCDate() + 30);
      transaction.create(idempotencyRef, {
        actorId: input.agentId,
        command: `agent-recovery:${input.operation}`,
        ...(authorizationRevision === undefined
          ? {}
          : { authorizationRevision }),
        requestFingerprint,
        operation: input.operation,
        agentId: input.agentId,
        credentialId,
        status: resultingStatus,
        completedAt: Timestamp.fromDate(input.occurredAt),
        expireAt: Timestamp.fromDate(expireAt),
      });
      transaction.update(challengeRef, {
        consumedAt: Timestamp.fromDate(input.occurredAt),
        completionIdempotencyId: idempotencyId,
      });
      return Object.freeze({
        kind: "created" as const,
        operation: input.operation,
        agentId: input.agentId,
        credentialId,
        status: resultingStatus,
        completedAt: input.occurredAt,
        ...(authorizationRevision === undefined
          ? {}
          : { authorizationRevision }),
      });
    });
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

  async createOperatorInvitation(
    input: OperatorInvitationCreationInput,
  ): Promise<Readonly<{ invitationId: string; created: boolean }>> {
    const secretDigest = await this.digestSecret(input.invitationSecret);
    if (!secretDigest || secretDigest === input.invitationSecret)
      throw new UnsafeOperatorSecretDigestError();
    const route = "POST /v1/operator/invitations";
    const requestFingerprint = hash(input.intendedIdentity);
    return this.firestore.runTransaction(async (transaction) => {
      const authorityRef = this.firestore
        .collection(collections.moderatorAuthorities)
        .doc(input.issuerOperatorId);
      const invitationRef = this.firestore
        .collection(collections.operatorInvitations)
        .doc(input.invitationId);
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(
          idempotencyDocumentId(
            `operator:${input.issuerOperatorId}`,
            route,
            input.idempotencyKey,
          ),
        );
      const [authority, invitation, existing] = await Promise.all([
        transaction.get(authorityRef),
        transaction.get(invitationRef),
        transaction.get(idempotencyRef),
      ]);
      if (existing.exists) {
        if (existing.data()!.requestFingerprint !== requestFingerprint)
          throw new IdempotencyRequestConflictError();
        return Object.freeze({
          invitationId: String(existing.data()!.invitationId),
          created: false,
        });
      }
      if (!authority.exists) throw new OperatorControlDeniedError();
      if (invitation.exists) throw new IdempotencyRequestConflictError();
      transaction.create(invitationRef, {
        intendedIdentity: input.intendedIdentity,
        secretDigest,
        issuerOperatorId: input.issuerOperatorId,
        issuedAt: Timestamp.fromDate(input.occurredAt),
        expiresAt: Timestamp.fromDate(input.expiresAt),
        recipientProofAt: null,
        acceptedAt: null,
        acceptedOperatorId: null,
        revokedAt: null,
      });
      writeOperatorAudit(
        this.firestore,
        transaction,
        "operator.invitation_created",
        { type: "operator", id: input.issuerOperatorId },
        input.invitationId,
        input.occurredAt,
        input.correlationId,
      );
      saveOperatorIdempotency(
        transaction,
        idempotencyRef,
        input.issuerOperatorId,
        route,
        input.idempotencyKey,
        requestFingerprint,
        { status: 201, body: { data: { invitationId: input.invitationId } } },
        input.occurredAt,
      );
      transaction.update(idempotencyRef, { invitationId: input.invitationId });
      return Object.freeze({ invitationId: input.invitationId, created: true });
    });
  }

  async createOperatorChallenge(
    input: OperatorChallengeCreationInput,
  ): Promise<
    Readonly<{ accepted: boolean; created: boolean; challengeId: string }>
  > {
    const challengeDigest = await this.digestSecret(input.challengeSecret);
    if (!challengeDigest || challengeDigest === input.challengeSecret)
      throw new UnsafeOperatorSecretDigestError();
    const route = "POST /v1/operator/challenges";
    const requestFingerprint = hash(input.normalizedIdentity);
    return this.firestore.runTransaction(async (transaction) => {
      const invitationQuery = this.firestore
        .collection(collections.operatorInvitations)
        .where("intendedIdentity", "==", input.normalizedIdentity);
      const operatorQuery = this.firestore
        .collection(collections.operators)
        .where("normalizedIdentity", "==", input.normalizedIdentity)
        .limit(1);
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(
          idempotencyDocumentId(
            `identity:${input.normalizedIdentity}`,
            route,
            input.idempotencyKey,
          ),
        );
      const [invitations, operators, existing] = await Promise.all([
        transaction.get(invitationQuery),
        transaction.get(operatorQuery),
        transaction.get(idempotencyRef),
      ]);
      if (existing.exists) {
        if (existing.data()!.requestFingerprint !== requestFingerprint)
          throw new IdempotencyRequestConflictError();
        const challengeId = existing.data()!.challengeId;
        if (typeof challengeId !== "string" || !challengeId)
          throw new IdempotencyRequestConflictError(
            "Request a new Operator challenge with a new idempotency key.",
          );
        return Object.freeze({
          accepted: existing.data()!.accepted === true,
          created: false,
          challengeId,
        });
      }
      const accepted =
        !operators.empty ||
        invitations.docs.some((invitation) => {
          const { acceptedAt, revokedAt, expiresAt } = invitation.data();
          return (
            !acceptedAt &&
            !revokedAt &&
            asDate(expiresAt).getTime() > input.occurredAt.getTime()
          );
        });
      if (accepted) {
        const expiresAt = new Date(
          input.occurredAt.getTime() + 10 * 60 * 1_000,
        );
        transaction.create(
          this.firestore
            .collection(collections.operatorChallenges)
            .doc(input.challengeId),
          {
            normalizedIdentity: input.normalizedIdentity,
            secretDigest: challengeDigest,
            createdAt: Timestamp.fromDate(input.occurredAt),
            expiresAt: Timestamp.fromDate(expiresAt),
            consumedAt: null,
          },
        );
      }
      saveOperatorIdempotency(
        transaction,
        idempotencyRef,
        input.normalizedIdentity,
        route,
        input.idempotencyKey,
        requestFingerprint,
        {
          status: 202,
          body: { data: { accepted: true, challengeId: input.challengeId } },
        },
        input.occurredAt,
      );
      transaction.update(idempotencyRef, {
        accepted,
        challengeId: input.challengeId,
      });
      return Object.freeze({
        accepted,
        created: true,
        challengeId: input.challengeId,
      });
    });
  }

  async acceptOperatorInvitationIdempotently(
    input: OperatorEnrollmentCommandInput,
  ): Promise<OperatorSessionCommandResult> {
    if (!isAllowedWebOrigin(input.origin))
      throw new OperatorEnrollmentRejectedError();
    const [invitationDigest, challengeDigest, sessionDigest] =
      await Promise.all([
        this.digestSecret(input.invitationSecret),
        this.digestSecret(input.challengeSecret),
        this.digestSecret(input.sessionSecret),
      ]);
    const route = `POST /v1/operator/invitations/${input.invitationId}/accept`;
    const idempotencyId = idempotencyDocumentId(
      `invitation:${input.invitationId}`,
      route,
      input.idempotencyKey,
    );
    const requestFingerprint = hash(
      JSON.stringify([
        invitationDigest,
        input.challengeId,
        challengeDigest,
        input.origin,
      ]),
    );
    return this.firestore.runTransaction(async (transaction) => {
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(idempotencyId);
      const existing = await transaction.get(idempotencyRef);
      if (existing.exists) {
        const data = existing.data()!;
        if (data.requestFingerprint !== requestFingerprint)
          throw new IdempotencyRequestConflictError();
        const response = data.response as StoredResponseRecord;
        const body = (response.body as { data: Record<string, string> }).data;
        return Object.freeze({
          kind: "replay" as const,
          operatorId: body.operatorId!,
          sessionId: body.sessionId!,
          expiresAt: new Date(body.expiresAt!),
          response,
        });
      }
      const invitationRef = this.firestore
        .collection(collections.operatorInvitations)
        .doc(input.invitationId);
      const challengeRef = this.firestore
        .collection(collections.operatorChallenges)
        .doc(input.challengeId);
      const operatorRef = this.firestore
        .collection(collections.operators)
        .doc(input.operatorId);
      const [invitation, challenge, operator] = await Promise.all([
        transaction.get(invitationRef),
        transaction.get(challengeRef),
        transaction.get(operatorRef),
      ]);
      assertInvitationEnrollment({
        invitation: invitation.exists
          ? mapOperatorInvitation(invitation.id, invitation.data()!)
          : null,
        challenge: challenge.exists
          ? mapOperatorChallenge(challenge.id, challenge.data()!)
          : null,
        invitationDigest,
        challengeDigest,
        at: input.occurredAt,
        digestsMatch: constantTimeEqual,
      });
      if (operator.exists) throw new OperatorEnrollmentRejectedError();
      const session = createOperatorSession({
        id: input.sessionId,
        operatorId: input.operatorId,
        rawSecret: input.sessionSecret,
        secretDigest: sessionDigest,
        origin: input.origin,
        authenticatedAt: input.occurredAt,
      });
      const sessionRef = this.firestore
        .collection(collections.operatorSessions)
        .doc(session.id);
      if ((await transaction.get(sessionRef)).exists)
        throw new OperatorEnrollmentRejectedError();
      transaction.update(invitationRef, {
        acceptedAt: Timestamp.fromDate(input.occurredAt),
        acceptedOperatorId: input.operatorId,
        recipientProofAt: Timestamp.fromDate(input.occurredAt),
      });
      transaction.update(challengeRef, {
        consumedAt: Timestamp.fromDate(input.occurredAt),
      });
      transaction.create(operatorRef, {
        normalizedIdentity: invitation.data()!.intendedIdentity,
        sourceInvitationId: input.invitationId,
        createdAt: Timestamp.fromDate(input.occurredAt),
      });
      transaction.create(sessionRef, serializeOperatorSession(session));
      const response = operatorSessionResponse(
        201,
        input.operatorId,
        session.id,
        session.authenticatedAt,
        session.expiresAt,
      );
      writeOperatorAudit(
        this.firestore,
        transaction,
        "operator.enrolled",
        { type: "system", id: "invitation-authority" },
        input.operatorId,
        input.occurredAt,
        input.correlationId,
      );
      saveOperatorIdempotency(
        transaction,
        idempotencyRef,
        input.invitationId,
        route,
        input.idempotencyKey,
        requestFingerprint,
        response,
        input.occurredAt,
      );
      return Object.freeze({
        kind: "created" as const,
        operatorId: input.operatorId,
        sessionId: session.id,
        expiresAt: session.expiresAt,
        response,
      });
    });
  }

  async createOperatorSessionIdempotently(
    input: OperatorSessionCommandInput,
  ): Promise<OperatorSessionCommandResult> {
    if (!isAllowedWebOrigin(input.origin))
      throw new OperatorAuthenticationRejectedError();
    const [challengeDigest, sessionDigest] = await Promise.all([
      this.digestSecret(input.challengeSecret),
      this.digestSecret(input.sessionSecret),
    ]);
    const route = "POST /v1/operator/sessions";
    const idempotencyId = idempotencyDocumentId(
      `operator:${input.normalizedIdentity}`,
      route,
      input.idempotencyKey,
    );
    const requestFingerprint = hash(
      JSON.stringify([
        input.normalizedIdentity,
        input.challengeId,
        challengeDigest,
        input.origin,
      ]),
    );
    return this.firestore.runTransaction(async (transaction) => {
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(idempotencyId);
      const existing = await transaction.get(idempotencyRef);
      if (existing.exists) {
        if (existing.data()!.requestFingerprint !== requestFingerprint)
          throw new IdempotencyRequestConflictError();
        const response = existing.data()!.response as StoredResponseRecord;
        const body = (response.body as { data: Record<string, string> }).data;
        return Object.freeze({
          kind: "replay" as const,
          operatorId: body.operatorId!,
          sessionId: body.sessionId!,
          expiresAt: new Date(body.expiresAt!),
          response,
        });
      }
      const operatorsQuery = this.firestore
        .collection(collections.operators)
        .where("normalizedIdentity", "==", input.normalizedIdentity)
        .limit(2);
      const challengeRef = this.firestore
        .collection(collections.operatorChallenges)
        .doc(input.challengeId);
      const [operators, challenge] = await Promise.all([
        transaction.get(operatorsQuery),
        transaction.get(challengeRef),
      ]);
      const operator = operators.docs.length === 1 ? operators.docs[0]! : null;
      assertOperatorAuthentication({
        operatorIdentity: operator
          ? String(operator.data().normalizedIdentity)
          : null,
        challenge: challenge.exists
          ? mapOperatorChallenge(challenge.id, challenge.data()!)
          : null,
        challengeDigest,
        at: input.occurredAt,
        digestsMatch: constantTimeEqual,
      });
      const activeSessions = await transaction.get(
        this.firestore
          .collection(collections.operatorSessions)
          .where("operatorId", "==", operator!.id),
      );
      const session = createOperatorSession({
        id: input.sessionId,
        operatorId: operator!.id,
        rawSecret: input.sessionSecret,
        secretDigest: sessionDigest,
        origin: input.origin,
        authenticatedAt: input.occurredAt,
      });
      const sessionRef = this.firestore
        .collection(collections.operatorSessions)
        .doc(session.id);
      if ((await transaction.get(sessionRef)).exists)
        throw new OperatorAuthenticationRejectedError();
      transaction.update(challengeRef, {
        consumedAt: Timestamp.fromDate(input.occurredAt),
      });
      for (const existingSession of activeSessions.docs) {
        if (!existingSession.data().revokedAt) {
          transaction.update(existingSession.ref, {
            revokedAt: Timestamp.fromDate(input.occurredAt),
          });
        }
      }
      transaction.create(sessionRef, serializeOperatorSession(session));
      const response = operatorSessionResponse(
        201,
        operator!.id,
        session.id,
        session.authenticatedAt,
        session.expiresAt,
      );
      writeOperatorAudit(
        this.firestore,
        transaction,
        "operator.authenticated",
        { type: "operator", id: operator!.id },
        operator!.id,
        input.occurredAt,
        input.correlationId,
      );
      saveOperatorIdempotency(
        transaction,
        idempotencyRef,
        operator!.id,
        route,
        input.idempotencyKey,
        requestFingerprint,
        response,
        input.occurredAt,
      );
      return Object.freeze({
        kind: "created" as const,
        operatorId: operator!.id,
        sessionId: session.id,
        expiresAt: session.expiresAt,
        response,
      });
    });
  }

  async revokeOperatorSessionIdempotently(
    input: OperatorSessionRevocationInput,
  ): Promise<Readonly<{ response: StoredResponseRecord }>> {
    const route = "DELETE /v1/operator/sessions/current";
    const idempotencyId = idempotencyDocumentId(
      `operator:${input.operatorId}`,
      route,
      input.idempotencyKey,
    );
    const requestFingerprint = hash(
      JSON.stringify([input.operatorId, input.sessionId, input.origin]),
    );
    return this.firestore.runTransaction(async (transaction) => {
      const idempotencyRef = this.firestore
        .collection(collections.idempotency)
        .doc(idempotencyId);
      const existing = await transaction.get(idempotencyRef);
      if (existing.exists) {
        if (existing.data()!.requestFingerprint !== requestFingerprint)
          throw new IdempotencyRequestConflictError();
        return Object.freeze({
          response: existing.data()!.response as StoredResponseRecord,
        });
      }
      const sessionRef = this.firestore
        .collection(collections.operatorSessions)
        .doc(input.sessionId);
      const session = await transaction.get(sessionRef);
      if (
        !session.exists ||
        session.data()?.operatorId !== input.operatorId ||
        session.data()?.origin !== input.origin
      ) {
        throw new OperatorAuthenticationRejectedError();
      }
      if (!session.data()?.revokedAt) {
        transaction.update(sessionRef, {
          revokedAt: Timestamp.fromDate(input.occurredAt),
        });
        writeOperatorAudit(
          this.firestore,
          transaction,
          "operator.session_revoked",
          { type: "operator", id: input.operatorId },
          input.operatorId,
          input.occurredAt,
          input.correlationId,
        );
      }
      const response: StoredResponseRecord = {
        status: 200,
        body: { data: { revoked: true } },
      };
      saveOperatorIdempotency(
        transaction,
        idempotencyRef,
        input.operatorId,
        route,
        input.idempotencyKey,
        requestFingerprint,
        response,
        input.occurredAt,
      );
      return Object.freeze({ response });
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
          this.readPortableAgentSnapshot(input, agentId),
      },
      input.agentId as AgentId,
      input.exportedAt,
    );
  }

  private async readPortableAgentSnapshot(
    authority: OperatorPortableExportInput,
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
        !(
          authority.actorAgentId === agentId ||
          (authority.operatorId !== undefined &&
            profile.data()?.controllingOperatorId === authority.operatorId)
        )
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
      const currentModeration = [
        mapExportModeration({
          subjectType: "agent",
          subjectId: agentId,
          state: profileData.status,
          reasonCategory: profileData.moderationReasonCategory,
          actionAt: profileData.moderatedAt,
        }),
        ...items.docs.map((item) => {
          const data = item.data();
          return mapExportModeration({
            subjectType: "public_item",
            subjectId: item.id,
            state: data.visibility,
            reasonCategory: data.moderationReasonCategory,
            actionAt: data.moderatedAt,
          });
        }),
      ].filter((record) => record !== null);
      const currentSubjects = new Set(
        currentModeration.map(
          (record) => `${record.subjectType}:${record.subjectId}`,
        ),
      );

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
          [
            ...currentModeration,
            ...moderationSnapshots
              .flatMap((snapshot) => snapshot.docs)
              .map((snapshot) => mapExportModeration(snapshot.data()))
              .filter(
                (record): record is ExportPublicModerationState =>
                  record !== null &&
                  !currentSubjects.has(
                    `${record.subjectType}:${record.subjectId}`,
                  ),
              ),
          ].sort((left, right) =>
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

  async submitReportIdempotently(
    input: SubmitReportTransactionInput,
  ): Promise<Readonly<{ response: StoredResponseRecord }>> {
    if (!isModerationReasonCategory(input.reasonCategory)) {
      throw new TypeError("The report reason category is invalid.");
    }
    const token = parseCredentialToken(input.credentialSecret);
    if (!token || token.credentialId !== input.credentialId) {
      throw new CredentialWriteBlockedError();
    }
    const secretDigest = await this.digestSecret(token.secret);
    const route = "POST /v1/reports";
    const fingerprint = JSON.stringify({
      target: input.target,
      reasonCategory: input.reasonCategory,
    });
    const commandId = idempotencyDocumentId(
      input.authenticatedAgentId,
      route,
      input.idempotencyKey,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const commandRef = this.firestore
        .collection(collections.idempotency)
        .doc(commandId);
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
        .collection(
          input.target.type === "agent_profile"
            ? collections.profiles
            : collections.items,
        )
        .doc(input.target.id);
      const [command, credential, profile, access, target] = await Promise.all([
        transaction.get(commandRef),
        transaction.get(credentialRef),
        transaction.get(profileRef),
        transaction.get(accessRef),
        transaction.get(targetRef),
      ]);
      if (command.exists) {
        if (command.data()?.requestFingerprint !== fingerprint) {
          throw new IdempotencyRequestConflictError();
        }
        return Object.freeze({
          response: command.data()!.response as StoredResponseRecord,
        });
      }
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
      const agentStatus = profile.data()?.status;
      if (agentStatus !== "active") {
        throw new AgentWriteBlockedError(
          agentStatus === "stopped" ? "stopped" : "suspended",
        );
      }
      if (
        !target.exists ||
        (input.target.type === "public_item" &&
          target.data()?.visibility !== "visible")
      ) {
        throw new ReportTargetNotFoundError();
      }
      await this.safety.authorizeAgentWrite(
        transaction,
        input.authenticatedAgentId,
        "report.create",
        input.occurredAt,
      );
      const policy = FIRST_RELEASE_COMMAND_RATE_LIMITS["report.create"];
      const rateLimit = await readRateLimitBucket(
        this.firestore,
        transaction,
        input.authenticatedAgentId,
        input.credentialId,
        "report.create",
        input.occurredAt,
        policy,
      );
      if (rateLimit.count >= policy.limit)
        throw new RateLimitExceededError(rateLimit.resetAt);

      const reportId = hash(`report:${commandId}`).slice(0, 32);
      const reportRef = this.firestore
        .collection(collections.reports)
        .doc(reportId);
      const response: StoredResponseRecord = {
        status: 201,
        body: {
          data: {
            id: reportId,
            target: input.target,
            reasonCategory: input.reasonCategory,
            reportedAt: input.occurredAt.toISOString(),
            status: "open",
          },
        },
      };
      transaction.create(reportRef, {
        id: reportId,
        reportingAgentId: input.authenticatedAgentId,
        targetType: input.target.type,
        targetId: input.target.id,
        reasonCategory: input.reasonCategory,
        reportedAt: Timestamp.fromDate(input.occurredAt),
        resolvedAt: null,
      });
      const audit = createAuditRecordInput({
        actor: { type: "agent", id: input.authenticatedAgentId },
        action: "report.created",
        subject: { type: "report", id: createAuditIdentifier(reportId) },
        details: {
          result: "completed",
          reasonCategory: input.reasonCategory,
          previousState: null,
          resultingState: { reportStatus: "open" },
          correlationId: createAuditCorrelationId(input.correlationId),
          requestOrigin: null,
          credentialId: auditCredentialIdentifier(input.credentialId),
          retentionRange: null,
        },
        createdAt: input.occurredAt,
      });
      const auditId = hash(`audit:${commandId}`).slice(0, 32);
      transaction.create(
        this.firestore.collection(collections.audits).doc(auditId),
        serializeAudit(auditId, audit),
      );
      const expireAt = new Date(input.occurredAt);
      expireAt.setUTCDate(expireAt.getUTCDate() + 30);
      transaction.create(commandRef, {
        agentId: input.authenticatedAgentId,
        command: route,
        keyHash: hash(input.idempotencyKey),
        requestFingerprint: fingerprint,
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
        command: "report.create",
        windowStartedAt: Timestamp.fromDate(rateLimit.windowStartedAt),
        count: rateLimit.count + 1,
        resetAt: Timestamp.fromDate(rateLimit.resetAt),
        expireAt: Timestamp.fromDate(rateLimit.expireAt),
      });
      return Object.freeze({ response });
    });
  }

  async findReportForAgent(
    reportId: string,
    reportingAgentId: AgentId,
  ): Promise<ReportRecord | null> {
    const snapshot = await this.firestore
      .collection(collections.reports)
      .doc(reportId)
      .get();
    if (
      !snapshot.exists ||
      snapshot.data()?.reportingAgentId !== reportingAgentId
    ) {
      return null;
    }
    return mapReport(snapshot);
  }

  async listOpenReports(operatorId: string): Promise<readonly ReportRecord[]> {
    const authority = await this.firestore
      .collection(collections.moderatorAuthorities)
      .doc(operatorId)
      .get();
    if (!authority.exists) throw new ModeratorAuthorityDeniedError();
    const reports = await this.firestore
      .collection(collections.reports)
      .where("resolvedAt", "==", null)
      .orderBy("reportedAt", "asc")
      .orderBy("id", "asc")
      .limit(100)
      .get();
    return Object.freeze(
      reports.docs
        .map(mapReport)
        .sort(
          (left, right) =>
            left.reportedAt.getTime() - right.reportedAt.getTime(),
        ),
    );
  }

  async reviewReportIdempotently(
    input: ReviewReportTransactionInput,
  ): Promise<Readonly<{ response: StoredResponseRecord }>> {
    if (
      !isReportReviewDecision(input.decision) ||
      !isModerationReasonCategory(input.reasonCategory)
    ) {
      throw new InvalidReportReviewDecisionError();
    }
    const note = input.internalNote?.trim();
    if (note && note.length > 2_000)
      throw new InvalidReportReviewDecisionError();
    const route = `POST /v1/moderator/reports/${input.reportId}/review`;
    const fingerprint = JSON.stringify({
      decision: input.decision,
      reasonCategory: input.reasonCategory,
      internalNote: note ?? null,
    });
    const commandId = idempotencyDocumentId(
      input.operatorId,
      route,
      input.idempotencyKey,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const authorityRef = this.firestore
        .collection(collections.moderatorAuthorities)
        .doc(input.operatorId);
      const reportRef = this.firestore
        .collection(collections.reports)
        .doc(input.reportId);
      const commandRef = this.firestore
        .collection(collections.idempotency)
        .doc(commandId);
      const [authority, reportSnapshot, command] = await Promise.all([
        transaction.get(authorityRef),
        transaction.get(reportRef),
        transaction.get(commandRef),
      ]);
      if (!authority.exists) throw new ModeratorAuthorityDeniedError();
      if (command.exists) {
        if (command.data()?.requestFingerprint !== fingerprint)
          throw new IdempotencyRequestConflictError();
        return Object.freeze({
          response: command.data()!.response as StoredResponseRecord,
        });
      }
      if (!reportSnapshot.exists) throw new ReportNotFoundError();
      if (reportSnapshot.data()?.resolvedAt)
        throw new ReportAlreadyResolvedError();
      const report = mapReport(reportSnapshot);
      const validDecision =
        input.decision === "dismissed" ||
        (report.target.type === "agent_profile" &&
          input.decision === "agent_suspended") ||
        (report.target.type === "public_item" &&
          input.decision === "content_hidden");
      if (!validDecision) throw new InvalidReportReviewDecisionError();
      const subjectRef = this.firestore
        .collection(
          report.target.type === "agent_profile"
            ? collections.profiles
            : collections.items,
        )
        .doc(report.target.id);
      const subject = await transaction.get(subjectRef);
      if (!subject.exists) throw new ReportTargetNotFoundError();

      let changed = false;
      let publicState: Record<string, unknown>;
      let moderationAction: "agent.suspended" | "content.hidden" | null = null;
      let previousState: AuditState | null = null;
      let resultingState: AuditState | null = null;
      if (report.target.type === "agent_profile") {
        const current = subject.data()?.status as
          "active" | "stopped" | "suspended";
        if (input.decision === "agent_suspended" && current !== "suspended") {
          const credentials = await transaction.get(
            this.firestore
              .collection(collections.credentials)
              .where("agentId", "==", report.target.id),
          );
          const activeCredentials = credentials.docs.filter((candidate) =>
            credentialIsActive(candidate.data(), input.occurredAt),
          );
          transaction.update(subjectRef, {
            status: moderationAgentTransition(current, "suspend").status,
            statusBeforeSuspension: moderationAgentTransition(
              current,
              "suspend",
            ).statusBeforeSuspension,
            moderationReasonCategory: input.reasonCategory,
            moderatedAt: Timestamp.fromDate(input.occurredAt),
            updatedAt: Timestamp.fromDate(input.occurredAt),
          });
          for (const credential of activeCredentials) {
            transaction.update(credential.ref, {
              revokedAt: Timestamp.fromDate(input.occurredAt),
            });
          }
          transaction.set(
            this.firestore.collection(collections.access).doc(report.target.id),
            { activeCredentialId: null },
            { merge: true },
          );
          changed = true;
          moderationAction = "agent.suspended";
          previousState = {
            agentStatus: current === "stopped" ? "stopped" : "active",
          };
          resultingState = { agentStatus: "suspended" };
        }
        publicState =
          input.decision === "agent_suspended"
            ? {
                id: report.target.id,
                type: report.target.type,
                status: "suspended",
                reasonCategory: input.reasonCategory,
                actionTime: input.occurredAt.toISOString(),
              }
            : {
                id: report.target.id,
                type: report.target.type,
                status: current,
              };
      } else {
        const current = subject.data()?.visibility as "visible" | "hidden";
        if (input.decision === "content_hidden" && current !== "hidden") {
          transaction.update(subjectRef, {
            visibility: moderationContentTransition(current, "hide").visibility,
            moderationReasonCategory: input.reasonCategory,
            moderatedAt: Timestamp.fromDate(input.occurredAt),
          });
          changed = true;
          moderationAction = "content.hidden";
          previousState = { publicItemStatus: "visible" };
          resultingState = { publicItemStatus: "hidden" };
        }
        publicState =
          input.decision === "content_hidden"
            ? {
                id: report.target.id,
                type: report.target.type,
                visibility: "hidden",
                reasonCategory: input.reasonCategory,
                actionTime: input.occurredAt.toISOString(),
              }
            : {
                id: report.target.id,
                type: report.target.type,
                visibility: current,
              };
      }

      transaction.update(reportRef, {
        decision: input.decision,
        reviewReasonCategory: input.reasonCategory,
        internalNote: note ?? null,
        moderatorId: input.operatorId,
        resolvedAt: Timestamp.fromDate(input.occurredAt),
      });
      if (moderationAction) {
        const moderationAudit = moderatorAudit({
          operatorId: input.operatorId,
          action: moderationAction,
          subjectType:
            report.target.type === "agent_profile" ? "agent" : "public_item",
          subjectId: report.target.id,
          reasonCategory: input.reasonCategory,
          previousState,
          resultingState,
          occurredAt: input.occurredAt,
          correlationId: input.correlationId,
        });
        const auditId = hash(`audit:moderation:${commandId}`).slice(0, 32);
        transaction.create(
          this.firestore.collection(collections.audits).doc(auditId),
          serializeAudit(auditId, moderationAudit),
        );
      }
      const reportAudit = moderatorAudit({
        operatorId: input.operatorId,
        action: "report.resolved",
        subjectType: "report",
        subjectId: input.reportId,
        reasonCategory: input.reasonCategory,
        previousState: { reportStatus: "open" },
        resultingState: { reportStatus: "resolved" },
        occurredAt: input.occurredAt,
        correlationId: input.correlationId,
      });
      const reportAuditId = hash(`audit:report:${commandId}`).slice(0, 32);
      transaction.create(
        this.firestore.collection(collections.audits).doc(reportAuditId),
        serializeAudit(reportAuditId, reportAudit),
      );
      const response: StoredResponseRecord = {
        status: 200,
        body: {
          data: {
            id: input.reportId,
            status: "resolved",
            decision: input.decision,
            reasonCategory: input.reasonCategory,
            reviewedAt: input.occurredAt.toISOString(),
            target: report.target,
            changed,
            publicState,
          },
        },
      };
      const expireAt = new Date(input.occurredAt);
      expireAt.setUTCDate(expireAt.getUTCDate() + 30);
      transaction.create(commandRef, {
        agentId: input.operatorId,
        command: route,
        keyHash: hash(input.idempotencyKey),
        requestFingerprint: fingerprint,
        response,
        completedAt: Timestamp.fromDate(input.occurredAt),
        expireAt: Timestamp.fromDate(expireAt),
      });
      return Object.freeze({ response });
    });
  }

  async findPublicModerationState(
    target: ReportTargetRecord,
  ): Promise<Readonly<Record<string, unknown>> | null> {
    const snapshot = await this.firestore
      .collection(
        target.type === "agent_profile"
          ? collections.profiles
          : collections.items,
      )
      .doc(target.id)
      .get();
    if (!snapshot.exists) return null;
    const data = snapshot.data()!;
    const category = data.moderationReasonCategory;
    const at = optionalDate(data.moderatedAt);
    return Object.freeze({
      id: target.id,
      type: target.type,
      ...(target.type === "agent_profile"
        ? { status: data.status }
        : { visibility: data.visibility }),
      ...(category && at
        ? { reasonCategory: category, actionTime: at.toISOString() }
        : {}),
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
        writePublicationMetric(
          this.firestore,
          transaction,
          "reposts",
          input.occurredAt,
        );
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
      writePublicationMetric(
        this.firestore,
        transaction,
        parentPostId === null ? "posts" : "replies",
        input.occurredAt,
      );
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

function mapOperatorInvitation(id: string, data: DocumentData) {
  return {
    id,
    intendedIdentity: String(data.intendedIdentity ?? ""),
    secretDigest: String(data.secretDigest ?? ""),
    expiresAt: asDate(data.expiresAt),
    acceptedAt: optionalDate(data.acceptedAt),
    revokedAt: optionalDate(data.revokedAt),
  };
}

function mapOperatorChallenge(id: string, data: DocumentData) {
  return {
    id,
    normalizedIdentity: String(data.normalizedIdentity ?? ""),
    secretDigest: String(data.secretDigest ?? ""),
    expiresAt: asDate(data.expiresAt),
    consumedAt: optionalDate(data.consumedAt),
  };
}

function serializeOperatorSession(session: OperatorSessionRecord) {
  return {
    operatorId: session.operatorId,
    secretDigest: session.secretDigest,
    origin: session.origin,
    authenticatedAt: Timestamp.fromDate(session.authenticatedAt),
    expiresAt: Timestamp.fromDate(session.expiresAt),
    revokedAt: null,
  };
}

function operatorSessionResponse(
  status: number,
  operatorId: string,
  sessionId: string,
  authenticatedAt: Date,
  expiresAt: Date,
): StoredResponseRecord {
  return {
    status,
    body: {
      data: {
        operatorId,
        sessionId,
        authenticatedAt: authenticatedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      },
    },
  };
}

function saveOperatorIdempotency(
  transaction: Transaction,
  reference: FirebaseFirestore.DocumentReference,
  actorId: string,
  command: string,
  key: string,
  requestFingerprint: string,
  response: StoredResponseRecord,
  at: Date,
) {
  const expireAt = new Date(at);
  expireAt.setUTCDate(expireAt.getUTCDate() + 30);
  transaction.create(reference, {
    actorId,
    command,
    keyHash: hash(key),
    requestFingerprint,
    response,
    completedAt: Timestamp.fromDate(at),
    expireAt: Timestamp.fromDate(expireAt),
  });
}

function writeOperatorAudit(
  firestore: Firestore,
  transaction: Transaction,
  action:
    | "operator.invitation_created"
    | "operator.enrolled"
    | "operator.authenticated"
    | "operator.session_revoked",
  actor: { readonly type: "system" | "operator"; readonly id: string },
  operatorId: string,
  at: Date,
  correlationId: string,
) {
  const audit = createAuditRecordInput({
    actor: {
      type: actor.type,
      id: createAuditIdentifier(actor.id),
    },
    action,
    subject: {
      type: "operator",
      id: createAuditIdentifier(operatorId),
    },
    details: {
      result: "completed",
      reasonCategory: null,
      previousState: null,
      resultingState: null,
      correlationId: createAuditCorrelationId(correlationId),
      requestOrigin: createInternalRequestOrigin("hosted-api"),
      credentialId: null,
      retentionRange: null,
    },
    createdAt: at,
  });
  const auditRef = firestore.collection(collections.audits).doc();
  transaction.create(auditRef, serializeAudit(auditRef.id, audit));
}

function serializeProfile(profile: PublicAgentProfileRecord) {
  return {
    handle: profile.handle,
    displayName: profile.displayName,
    description: profile.description,
    status: profile.status,
    createdAt: Timestamp.fromDate(profile.createdAt),
    updatedAt: Timestamp.fromDate(profile.updatedAt),
    ...(profile.moderationReasonCategory
      ? { moderationReasonCategory: profile.moderationReasonCategory }
      : {}),
    ...(profile.moderatedAt
      ? { moderatedAt: Timestamp.fromDate(profile.moderatedAt) }
      : {}),
    ...(profile.controllingOperatorId
      ? { controllingOperatorId: profile.controllingOperatorId }
      : {}),
  };
}
function mapProfile(id: string, data: DocumentData): PublicAgentProfileRecord {
  const moderatedAt = optionalDate(data.moderatedAt);
  return Object.freeze({
    id,
    handle: data.handle as string,
    displayName: data.displayName as string,
    description: (data.description as string | null) ?? null,
    status: data.status as PublicAgentProfileRecord["status"],
    createdAt: asDate(data.createdAt),
    updatedAt: asDate(data.updatedAt),
    ...(data.moderationReasonCategory
      ? { moderationReasonCategory: data.moderationReasonCategory }
      : {}),
    ...(moderatedAt ? { moderatedAt } : {}),
  });
}
function mapReport(snapshot: FirebaseFirestore.DocumentSnapshot): ReportRecord {
  const data = snapshot.data()!;
  const reviewedAt = optionalDate(data.resolvedAt);
  return Object.freeze({
    id: snapshot.id,
    reportingAgentId: data.reportingAgentId as AgentId,
    target: Object.freeze({
      type: data.targetType as ReportTargetRecord["type"],
      id: data.targetId as string,
    }) as ReportTargetRecord,
    reasonCategory: data.reasonCategory as ReportRecord["reasonCategory"],
    reportedAt: asDate(data.reportedAt),
    status: reviewedAt ? "resolved" : "open",
    ...(data.decision ? { decision: data.decision } : {}),
    ...(reviewedAt ? { reviewedAt } : {}),
  });
}
function mapPost(
  snapshot: QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot,
  replyTotal: number,
  repostTotal: number,
): PublicPostRecord {
  const data = snapshot.data()!;
  return Object.freeze({
    id: snapshot.id as PostId,
    authorId: data.authorId as AgentId,
    text: data.deletedAt ? "[Deleted post]" : (data.text as string),
    publishedAt: asDate(data.publishedAt),
    parentId: (data.parentId as PostId | null) ?? null,
    conversationRootId: data.conversationRootId as PostId,
    authorHandle: data.authorHandle as string,
    authorDisplayName: data.authorDisplayName as string,
    acknowledgementTotal: Number(data.acknowledgementTotal ?? 0),
    replyTotal,
    repostTotal,
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
  data: DocumentData,
): ExportPublicModerationState | null {
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

function agentSecurityAudit(value: {
  readonly agentId: string;
  readonly action: "agent.registered" | "credential.issued";
  readonly subjectType: "credential" | "agent";
  readonly subjectId: ReturnType<typeof createAuditIdentifier>;
  readonly previousState: AuditState | null;
  readonly resultingState: AuditState;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly credentialId: string | null;
}): AuditRecordInput {
  return createAuditRecordInput({
    actor: { type: "agent", id: value.agentId as AgentId },
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

function agentRecoveryAudit(value: {
  readonly agentId: string;
  readonly action:
    | "credential.rotated"
    | "recovery_key.replaced"
    | "agent.stopped"
    | "operator.authorization_removed";
  readonly subjectType: "credential" | "recovery_key" | "agent";
  readonly subjectId: ReturnType<typeof createAuditIdentifier>;
  readonly previousState: AuditState | null;
  readonly resultingState: AuditState;
  readonly occurredAt: Date;
  readonly correlationId: string;
  readonly credentialId: string | null;
}): AuditRecordInput {
  return createAuditRecordInput({
    actor: { type: "agent", id: value.agentId as AgentId },
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

function mapAgentRecoveryResult(
  data: FirebaseFirestore.DocumentData,
): CompleteAgentRecoveryResult {
  return Object.freeze({
    kind: "replay" as const,
    operation: data.operation as AgentRecoveryOperation,
    agentId: String(data.agentId),
    credentialId: data.credentialId ? String(data.credentialId) : null,
    status: data.status as "active" | "stopped" | "suspended",
    ...(data.authorizationRevision === undefined
      ? {}
      : { authorizationRevision: Number(data.authorizationRevision) }),
    completedAt: asDate(data.completedAt),
  });
}

function moderatorAudit(value: {
  readonly operatorId: string;
  readonly action: "agent.suspended" | "content.hidden" | "report.resolved";
  readonly subjectType: "agent" | "public_item" | "report";
  readonly subjectId: string;
  readonly reasonCategory: "spam" | "impersonation" | "abuse" | "unsafe_link";
  readonly previousState: AuditState | null;
  readonly resultingState: AuditState | null;
  readonly occurredAt: Date;
  readonly correlationId: string;
}): AuditRecordInput {
  return createAuditRecordInput({
    actor: {
      type: "moderator",
      id: createAuditIdentifier(value.operatorId),
    },
    action: value.action,
    subject: {
      type: value.subjectType,
      id: createAuditIdentifier(value.subjectId),
    },
    details: {
      result: "completed",
      reasonCategory: value.reasonCategory,
      previousState: value.previousState,
      resultingState: value.resultingState,
      correlationId: createAuditCorrelationId(value.correlationId),
      requestOrigin: createInternalRequestOrigin("hosted-api"),
      credentialId: null,
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
  writes: 7,
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
    | "follow.change"
    | "report.create",
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

function writePublicationMetric(
  firestore: Firestore,
  transaction: Transaction,
  kind: "posts" | "replies" | "reposts",
  at: Date,
) {
  const instant = at.toISOString();
  for (const [collection, key] of [
    ["networkDailyMetrics", instant.slice(0, 10)],
    ["networkHourlyMetrics", instant.slice(0, 13)],
  ]) {
    transaction.set(
      firestore.collection(collection!).doc(key!),
      { [kind]: FieldValue.increment(1), observedAt: Timestamp.fromDate(at) },
      { merge: true },
    );
  }
}
