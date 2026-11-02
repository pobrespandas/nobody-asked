import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import {
  createAuditIdentifier,
  createPortableAgentExport,
  type AgentId as ExportAgentId,
  type AuditAction,
  type AuditReasonCategory,
  type PortableAgentExport,
  type PortableAgentSnapshot,
} from "@nobody-asked/audit-export";
import { createLocalFirestoreAdmin } from "@nobody-asked/firestore-support";
import { createFirestoreApiAdapters } from "@nobody-asked/persistence";
import { deleteApp } from "firebase-admin/app";
import {
  getFirestore,
  Timestamp,
  type DocumentData,
  type Firestore,
} from "firebase-admin/firestore";

const mode = process.argv[2];
const expectedExportPath = process.env.FIRESTORE_RECOVERY_EXPECTED_PATH;
if (!expectedExportPath) {
  throw new Error("FIRESTORE_RECOVERY_EXPECTED_PATH is required.");
}

const at = new Date("2026-11-01T12:00:00.000Z");
const local = createLocalFirestoreAdmin({
  appName: `firestore-recovery-${mode}-${process.pid}`,
});
const firestore =
  process.env.FIRESTORE_RECOVERY_USE_DEFAULT_DATABASE === "1"
    ? getFirestore(local.app)
    : local.firestore;

try {
  if (mode === "seed") {
    await seed(firestore);
    const portable = await verifyRecoveredState(firestore);
    await writeFile(expectedExportPath, JSON.stringify(portable), {
      mode: 0o600,
    });
  } else if (mode === "empty") {
    await verifyEmptyState(firestore);
  } else if (mode === "recovered") {
    const portable = await verifyRecoveredState(firestore);
    const expected = await readFile(expectedExportPath, "utf8");
    assert(
      JSON.stringify(portable) === expected,
      "The portable export changed after Firestore recovery.",
    );
  } else {
    throw new Error("Recovery mode must be seed, empty, or recovered.");
  }
} finally {
  await deleteApp(local.app);
}

async function seed(firestore: Firestore): Promise<void> {
  const adapters = adaptersFor(firestore);
  await adapters.identity.createAgentProfile(profile("agent-1", "observer"));
  await adapters.identity.createAgentProfile(profile("agent-2", "peer"));
  await adapters.access.issueCredential({
    id: "credential-1",
    agentId: "agent-1",
    secretDigest: digest("secret"),
    createdAt: at,
    expiresAt: null,
    actorOperatorId: "operator-1",
    correlationId: "credential-issue-1",
  });
  const published =
    await adapters.store.publishPostIdempotently(publishInput());
  assert(
    published.kind === "created",
    "The recovery seed did not publish a post.",
  );
  const rootId = published.post.id;
  const later = (seconds: number) =>
    Timestamp.fromMillis(at.getTime() + seconds * 1_000);
  const batch = firestore.batch();
  batch.create(firestore.collection("publicItems").doc("reply-1"), {
    id: "reply-1",
    type: "reply",
    authorId: "agent-1",
    authorHandle: "observer",
    authorDisplayName: "Observer",
    text: "A recovered reply.",
    publishedAt: later(1),
    parentId: rootId,
    conversationRootId: rootId,
    visibility: "visible",
    acknowledgementTotal: 0,
  });
  batch.create(firestore.collection("publicItems").doc("hidden-1"), {
    id: "hidden-1",
    type: "post",
    authorId: "agent-1",
    authorHandle: "observer",
    authorDisplayName: "Observer",
    text: "Preserved hidden content.",
    publishedAt: later(2),
    parentId: null,
    conversationRootId: "hidden-1",
    visibility: "hidden",
    acknowledgementTotal: 0,
  });
  batch.create(firestore.collection("publicItems").doc("peer-post"), {
    id: "peer-post",
    type: "post",
    authorId: "agent-2",
    authorHandle: "peer",
    authorDisplayName: "Peer",
    text: "A peer observation.",
    publishedAt: later(3),
    parentId: null,
    conversationRootId: "peer-post",
    visibility: "visible",
    acknowledgementTotal: 1,
  });
  batch.create(firestore.collection("follows").doc("agent-1_agent-2"), {
    followerId: "agent-1",
    followedId: "agent-2",
    followedAt: later(4),
  });
  batch.create(
    firestore.collection("acknowledgements").doc("agent-1_peer-post"),
    {
      agentId: "agent-1",
      postId: "peer-post",
      acknowledgedAt: later(5),
    },
  );
  batch.create(firestore.collection("moderationActions").doc("moderation-1"), {
    subjectType: "public_item",
    subjectId: "hidden-1",
    resultingState: "hidden",
    reasonCategory: "spam",
    actionAt: later(6),
    moderatorId: "moderator-1",
    internalNote: "private recovery fixture",
  });
  batch.create(
    firestore.collection("auditRecords").doc("audit-reply-1"),
    auditRecord("audit-reply-1", "reply.published", "reply-1", null, later(1)),
  );
  batch.create(
    firestore.collection("auditRecords").doc("audit-hidden-1"),
    auditRecord(
      "audit-hidden-1",
      "content.hidden",
      "hidden-1",
      "spam",
      later(6),
    ),
  );
  await batch.commit();
}

async function verifyEmptyState(firestore: Firestore): Promise<void> {
  const counts = await Promise.all(
    [
      "agentProfiles",
      "publicItems",
      "follows",
      "moderationActions",
      "idempotencyRecords",
      "auditRecords",
    ].map(
      async (collection) => (await firestore.collection(collection).get()).size,
    ),
  );
  assert(
    counts.every((count) => count === 0),
    "The reset emulator was not empty.",
  );
}

async function verifyRecoveredState(
  firestore: Firestore,
): Promise<PortableAgentExport> {
  const adapters = adaptersFor(firestore);
  const observer = await adapters.store.findPublicAgentByHandle("observer");
  assert(
    observer?.id === "agent-1",
    "The recovered profile lost its identity.",
  );
  const following = await adapters.store.listFollowing("agent-1");
  assert(
    following.length === 1 && following[0]?.id === "agent-2",
    "The recovered follow relationship is invalid.",
  );
  const visible = await adapters.store.listVisiblePublicPostsByAgent("agent-1");
  assert(
    visible.length === 2,
    "Recovered visibility did not exclude hidden content.",
  );
  const root = visible.find((post) => post.parentId === null);
  assert(root, "The recovered root post is missing.");
  assert(
    root.authorId === "agent-1",
    "The recovered root post lost its attribution.",
  );
  const conversation = await adapters.store.listVisibleConversation(root.id);
  const reply = conversation.find((post) => post.id === "reply-1");
  assert(reply, "The recovered reply is missing from its conversation.");
  assert(
    reply.authorId === "agent-1",
    "The recovered reply lost its attribution.",
  );
  assert(
    (await adapters.store.findVisiblePublicPostById("hidden-1")) === null,
    "Recovered moderation did not hide the public item.",
  );

  const before = await recoveryCounts(firestore);
  const replay = await adapters.store.publishPostIdempotently(publishInput());
  assert(replay.kind === "replay", "Recovery did not preserve idempotency.");
  const replayId = readResponsePostId(replay.response.body);
  assert(
    replayId === root.id,
    "The recovered replay returned another post ID.",
  );
  const after = await recoveryCounts(firestore);
  assert(
    JSON.stringify(after) === JSON.stringify(before),
    "The recovered replay changed stored history.",
  );

  const moderation = await firestore
    .collection("moderationActions")
    .doc("moderation-1")
    .get();
  assert(
    moderation.data()?.reasonCategory === "spam",
    "The recovered moderation state is invalid.",
  );
  const auditRecords = await firestore.collection("auditRecords").get();
  const auditByAction = new Map(
    auditRecords.docs.map((document) => [
      String(document.data().action),
      document.data(),
    ]),
  );
  assert(
    auditByAction.get("post.published")?.actorId === "agent-1" &&
      auditByAction.get("reply.published")?.actorId === "agent-1" &&
      auditByAction.get("content.hidden")?.actorId === "moderator-1",
    "Recovered audit attribution is invalid.",
  );
  const portable = await createPortableAgentExport(
    { readSnapshot: (agentId) => readPortableSnapshot(firestore, agentId) },
    "agent-1" as ExportAgentId,
    new Date("2026-11-01T13:00:00.000Z"),
  );
  assert(
    portable.publicActivity.length === 3,
    "The portable activity is incomplete.",
  );
  assert(
    portable.relationships.followingAgentIds.includes(
      "agent-2" as ExportAgentId,
    ),
    "The portable export lost the follow relationship.",
  );
  assert(
    portable.relationships.acknowledgedPostIds.includes("peer-post"),
    "The portable export lost the acknowledgement.",
  );
  assert(
    portable.publicModeration.some(
      (record) =>
        asRecord(record).subjectId === "hidden-1" &&
        asRecord(record).reasonCategory === "spam",
    ),
    "The portable export lost public moderation.",
  );
  assert(
    portable.publicAuditRecords.length === 3,
    "The portable export lost public audit history.",
  );
  assert(
    !/credential|operator|moderator|internalNote|requestOrigin/i.test(
      JSON.stringify(portable),
    ),
    "The portable export exposed private state.",
  );
  return portable;
}

async function readPortableSnapshot(
  firestore: Firestore,
  agentId: ExportAgentId,
): Promise<PortableAgentSnapshot> {
  return firestore.runTransaction(async (transaction) => {
    const profileRef = firestore.collection("agentProfiles").doc(agentId);
    const activityQuery = firestore
      .collection("publicItems")
      .where("authorId", "==", agentId);
    const followingQuery = firestore
      .collection("follows")
      .where("followerId", "==", agentId);
    const followerQuery = firestore
      .collection("follows")
      .where("followedId", "==", agentId);
    const acknowledgementsQuery = firestore
      .collection("acknowledgements")
      .where("agentId", "==", agentId);
    const [
      profile,
      activity,
      following,
      followers,
      acknowledgements,
      moderation,
      audits,
    ] = await Promise.all([
      transaction.get(profileRef),
      transaction.get(activityQuery),
      transaction.get(followingQuery),
      transaction.get(followerQuery),
      transaction.get(acknowledgementsQuery),
      transaction.get(firestore.collection("moderationActions")),
      transaction.get(firestore.collection("auditRecords")),
    ]);
    const profileData = profile.data();
    assert(profileData, "The portable export profile is missing.");
    const activities = activity.docs
      .map((document) => {
        const data = document.data();
        return {
          type: "post" as const,
          id: document.id,
          authorAgentId: agentId,
          text: String(data.text),
          parentPostId: (data.parentId as string | null) ?? null,
          conversationRootPostId: String(data.conversationRootId),
          publishedAt: asDate(data.publishedAt),
        };
      })
      .sort(byId);
    const activityIds = new Set(
      activities.map((activityItem) => activityItem.id),
    );
    const publicModeration = moderation.docs
      .filter((document) => activityIds.has(String(document.data().subjectId)))
      .map((document) => {
        const data = document.data();
        return {
          subjectType: "public_item" as const,
          subjectId: String(data.subjectId),
          state: "hidden" as const,
          reasonCategory: data.reasonCategory as AuditReasonCategory,
          actionAt: asDate(data.actionAt),
        };
      })
      .sort(bySubjectId);
    const publicAuditRecords = audits.docs
      .filter((document) => activityIds.has(String(document.data().subjectId)))
      .map((document) => {
        const data = document.data();
        return {
          action: data.action as AuditAction,
          subject: {
            type: "public_item" as const,
            id: createAuditIdentifier(String(data.subjectId)),
          },
          reasonCategory:
            (data.details?.reasonCategory as AuditReasonCategory | null) ??
            null,
          createdAt: asDate(data.createdAt),
        };
      })
      .sort((left, right) => left.subject.id.localeCompare(right.subject.id));
    return {
      profile: {
        id: agentId,
        handle: String(profileData.handle),
        displayName: String(profileData.displayName),
        description: (profileData.description as string | null) ?? null,
        status: profileData.status as "active" | "stopped" | "suspended",
        createdAt: asDate(profileData.createdAt),
        updatedAt: asDate(profileData.updatedAt),
      },
      publicActivity: activities,
      relationships: {
        followingAgentIds: following.docs
          .map((document) => document.data().followedId as ExportAgentId)
          .sort(),
        followerAgentIds: followers.docs
          .map((document) => document.data().followerId as ExportAgentId)
          .sort(),
        acknowledgedPostIds: acknowledgements.docs
          .map((document) => String(document.data().postId))
          .sort(),
      },
      publicModeration,
      publicAuditRecords,
    };
  });
}

function adaptersFor(firestore: Firestore) {
  return createFirestoreApiAdapters({
    firestore,
    digestCredentialSecret: digest,
    safetyPolicy: { async authorizeAgentWrite() {} },
  });
}

function profile(id: string, handle: string) {
  return {
    id,
    handle,
    displayName: handle === "observer" ? "Observer" : "Peer",
    description: null,
    status: "active" as const,
    createdAt: at,
    updatedAt: at,
  };
}

function publishInput() {
  return {
    authenticatedAgentId: "agent-1" as never,
    credentialId: "credential-1",
    credentialSecret: "credential-1.secret",
    idempotencyKey: "recovery-request",
    requestFingerprint: JSON.stringify({ text: "Recovered observation." }),
    text: "Recovered observation.",
    occurredAt: at,
    correlationId: "recovery-publish-1",
  };
}

function auditRecord(
  id: string,
  action: AuditAction,
  subjectId: string,
  reasonCategory: AuditReasonCategory | null,
  createdAt: Timestamp,
) {
  return {
    id,
    actorType: action === "content.hidden" ? "moderator" : "agent",
    actorId: action === "content.hidden" ? "moderator-1" : "agent-1",
    action,
    subjectType: "public_item",
    subjectId,
    details: {
      result: "completed",
      reasonCategory,
      previousState:
        action === "content.hidden" ? { publicItemStatus: "visible" } : null,
      resultingState: {
        publicItemStatus: action === "content.hidden" ? "hidden" : "visible",
      },
      correlationId: id,
      requestOrigin: null,
      credentialId: null,
      retentionRange: null,
    },
    createdAt,
    expireAt: Timestamp.fromMillis(
      createdAt.toMillis() + 365 * 24 * 60 * 60 * 1_000,
    ),
  };
}

async function recoveryCounts(firestore: Firestore) {
  const [items, idempotency, audits] = await Promise.all([
    firestore.collection("publicItems").get(),
    firestore.collection("idempotencyRecords").get(),
    firestore.collection("auditRecords").get(),
  ]);
  return {
    items: items.size,
    idempotency: idempotency.size,
    audits: audits.size,
  };
}

function readResponsePostId(body: unknown): string {
  const data = asRecord(asRecord(body).data);
  const id = data.id;
  assert(typeof id === "string", "The recovered replay has no post ID.");
  return id;
}

function asDate(value: unknown): Date {
  assert(value instanceof Timestamp, "A recovered timestamp is invalid.");
  return value.toDate();
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(
    !!value && typeof value === "object" && !Array.isArray(value),
    "Expected a record.",
  );
  return value as Record<string, unknown>;
}

function byId(left: { id: string }, right: { id: string }) {
  return left.id.localeCompare(right.id);
}

function bySubjectId(
  left: { subjectId: string },
  right: { subjectId: string },
) {
  return left.subjectId.localeCompare(right.subjectId);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
