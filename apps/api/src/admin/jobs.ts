import { randomUUID } from "node:crypto";
import {
  FieldPath,
  FieldValue,
  Timestamp,
  type Firestore,
  type Query,
  type DocumentSnapshot,
} from "firebase-admin/firestore";
import { appendAdminAudit, assertPrincipal } from "./actions.js";
import {
  digest,
  plain,
  project,
  requireAdmin,
  resources,
  version,
  type ActionInput,
  type Principal,
  type Resource,
} from "./contracts.js";

export interface LedgerEntry {
  id: string;
  targetType: "agents" | "content";
  targetId: string;
  requestedAt: string;
}
export interface JobObjects {
  writeLedger(entry: LedgerEntry): Promise<void>;
  writeArtifact(id: string, value: unknown): Promise<void>;
  readArtifact(id: string): Promise<unknown>;
  deleteArtifacts(prefix: string): Promise<boolean>;
  listLedger(
    cursor?: string,
  ): Promise<{ items: LedgerEntry[]; nextCursor: string | null }>;
}
export interface JobQueue {
  enqueue(id: string, attempt: string): Promise<void>;
}
const CHUNK = 100;
interface Phase {
  collection: string;
  field: string;
  mode: "delete" | "content";
}
const agentPhases: Phase[] = [
  { collection: "publicItems", field: "authorId", mode: "content" },
  { collection: "credentials", field: "agentId", mode: "delete" },
  { collection: "agentRegistrations", field: "agentId", mode: "delete" },
  { collection: "rateLimitBuckets", field: "agentId", mode: "delete" },
  {
    collection: "agentOperatorAuthorizations",
    field: "agentId",
    mode: "delete",
  },
  { collection: "agentRecoveryChallenges", field: "agentId", mode: "delete" },
  { collection: "follows", field: "followerId", mode: "delete" },
  { collection: "follows", field: "followedId", mode: "delete" },
  { collection: "acknowledgements", field: "agentId", mode: "delete" },
  { collection: "idempotencyRecords", field: "agentId", mode: "delete" },
  { collection: "idempotencyRecords", field: "actorId", mode: "delete" },
];
function contentMarker(snapshot: DocumentSnapshot, now: Date) {
  const data = snapshot.data()!;
  return Object.fromEntries(
    Object.entries({
      id: snapshot.id,
      type: data.type,
      authorId: data.authorId,
      publishedAt: data.publishedAt,
      parentId: data.parentId ?? null,
      conversationRootId: data.conversationRootId ?? snapshot.id,
      sourcePostId: data.sourcePostId ?? null,
      text: "",
      authorHandle: "deleted",
      authorDisplayName: "Deleted post",
      visibility: "deleted",
      deletedAt: Timestamp.fromDate(now),
    }).filter(([, value]) => value !== undefined),
  );
}
export class AdminJobs {
  constructor(
    readonly firestore: Firestore,
    readonly objects: JobObjects | null,
    readonly queue: JobQueue | null,
    readonly now = () => new Date(),
  ) {}
  async preview(kind: "agents" | "content", id: string) {
    const snapshot = await this.firestore
      .collection(resources[kind].collection)
      .doc(id)
      .get();
    requireAdmin(
      snapshot.exists &&
        !snapshot.data()?.deletedAt &&
        !snapshot.data()?.deletingAt,
      404,
      "record_not_found",
    );
    const access =
      kind === "agents"
        ? await this.firestore.collection("agentAccess").doc(id).get()
        : null;
    const credential = access?.data()?.activeCredentialId
      ? await this.firestore
          .collection("credentials")
          .doc(access.data()!.activeCredentialId)
          .get()
      : null;
    const accessVersion = access ? version(access) : null;
    const credentialVersion = credential ? version(credential) : null;
    const affected =
      kind === "agents"
        ? (
            await this.firestore
              .collection("publicItems")
              .where("authorId", "==", id)
              .count()
              .get()
          ).data().count
        : 1;
    const impact = digest(
      JSON.stringify({
        kind,
        id,
        version: version(snapshot),
        accessVersion,
        credentialVersion,
        affected,
      }),
    );
    return {
      targetType: kind,
      targetId: id,
      version: version(snapshot),
      accessVersion,
      credentialVersion,
      ownContentCount: affected,
      otherAgentsReplies: "preserved",
      backupRetention: "Existing backups retain data until expiration.",
      impact,
    };
  }
  async createDeletion(principal: Principal, input: ActionInput) {
    requireAdmin(
      this.objects && this.queue,
      503,
      "durable_jobs_not_configured",
    );
    requireAdmin(input.resource === "agents" || input.resource === "content");
    const id = digest(`${principal.operatorId}:${input.key}`);
    const fingerprint = digest(JSON.stringify(input));
    const existing = await this.firestore.collection("adminJobs").doc(id).get();
    if (existing.exists) {
      await this.firestore.runTransaction(async (transaction) => {
        await assertPrincipal(
          this.firestore,
          transaction,
          principal,
          this.now(),
        );
        const saved = await transaction.get(existing.ref);
        requireAdmin(
          saved.data()?.fingerprint === fingerprint,
          409,
          "idempotency_conflict",
        );
      });
      return { id, status: String(existing.data()!.status) };
    }
    const preview = await this.preview(input.resource, input.id);
    requireAdmin(
      input.impact === preview.impact &&
        input.confirmation === input.id &&
        principal.deletionIntent === preview.impact,
      409,
      "deletion_confirmation_required",
    );
    await this.firestore.runTransaction(async (transaction) => {
      await assertPrincipal(this.firestore, transaction, principal, this.now());
      const jobRef = this.firestore.collection("adminJobs").doc(id),
        target = this.firestore
          .collection(resources[input.resource].collection)
          .doc(input.id);
      const [existing, snapshot, session] = await Promise.all([
        transaction.get(jobRef),
        transaction.get(target),
        transaction.get(
          this.firestore
            .collection("operatorSessions")
            .doc(principal.sessionId),
        ),
      ]);
      if (existing.exists) {
        requireAdmin(
          existing.data()?.fingerprint === fingerprint,
          409,
          "idempotency_conflict",
        );
        return;
      }
      requireAdmin(
        version(snapshot) === input.version &&
          !snapshot.data()?.deletingAt &&
          session.data()?.adminDeletionIntent === input.impact,
        409,
        "record_conflict",
      );
      let credentialRefs: FirebaseFirestore.DocumentReference[] = [];
      if (input.resource === "agents") {
        const access = await transaction.get(
          this.firestore.collection("agentAccess").doc(input.id),
        );
        const credential = access.data()?.activeCredentialId
          ? await transaction.get(
              this.firestore
                .collection("credentials")
                .doc(access.data()!.activeCredentialId),
            )
          : null;
        requireAdmin(
          version(access) === preview.accessVersion &&
            (credential ? version(credential) : null) ===
              preview.credentialVersion,
          409,
          "record_conflict",
        );
        const credentials = await transaction.get(
          this.firestore
            .collection("credentials")
            .where("agentId", "==", input.id)
            .where("revokedAt", "==", null),
        );
        requireAdmin(
          credentials.size <= 100,
          409,
          "credential_invariant_failed",
        );
        credentialRefs = credentials.docs.map((doc) => doc.ref);
      }
      const exportAgentId =
        input.resource === "agents"
          ? input.id
          : String(snapshot.data()?.authorId ?? "");
      requireAdmin(exportAgentId, 409, "invalid_deletion_target");
      const exportStateRef = this.firestore
        .collection("agentExportState")
        .doc(exportAgentId);
      const exportState = await transaction.get(exportStateRef);
      const stamp = Timestamp.fromDate(this.now());
      transaction.set(
        exportStateRef,
        {
          epoch: Number(exportState.data()?.epoch ?? 0) + 1,
          pendingDeletions:
            Number(exportState.data()?.pendingDeletions ?? 0) + 1,
        },
        { merge: true },
      );
      transaction.update(target, {
        deletingAt: stamp,
        ...(input.resource === "agents"
          ? { status: "suspended" }
          : { visibility: "hidden" }),
      });
      for (const ref of credentialRefs)
        transaction.update(ref, { revokedAt: stamp });
      if (input.resource === "agents")
        transaction.set(
          this.firestore.collection("agentAccess").doc(input.id),
          { activeCredentialId: null },
          { merge: true },
        );
      transaction.update(session.ref, { adminDeletionIntent: null });
      transaction.create(jobRef, {
        kind: "deletion",
        exportAgentId,
        targetType: input.resource,
        targetId: input.id,
        requestedBy: principal.operatorId,
        reason: input.reason,
        requestedAt: stamp,
        updatedAt: stamp,
        phase: 0,
        processed: 0,
        cursor: null,
        status: "pending",
        fingerprint,
      });
      appendAdminAudit(
        this.firestore,
        transaction,
        principal,
        "deletion.requested",
        input.resource,
        input.id,
        input.reason,
        this.now(),
        { jobId: id },
      );
    });
    await this.dispatch(id);
    return {
      id,
      status: String(
        (await this.firestore.collection("adminJobs").doc(id).get()).data()
          ?.status ?? "pending",
      ),
    };
  }
  async createExport(
    principal: Principal,
    agentId: string,
    reason: string,
    key: string = randomUUID(),
  ) {
    requireAdmin(
      this.objects && this.queue,
      503,
      "durable_jobs_not_configured",
    );
    const id = digest(`export:${principal.operatorId}:${key}`);
    await this.firestore.runTransaction(async (transaction) => {
      await assertPrincipal(this.firestore, transaction, principal, this.now());
      const existing = await transaction.get(
        this.firestore.collection("adminJobs").doc(id),
      );
      if (existing.exists) {
        requireAdmin(
          existing.data()?.targetId === agentId &&
            existing.data()?.reason === reason &&
            existing.data()?.kind === "export",
          409,
          "idempotency_conflict",
        );
        return;
      }
      const agent = await transaction.get(
        this.firestore.collection("agentProfiles").doc(agentId),
      );
      requireAdmin(
        agent.exists && !agent.data()?.deletingAt && !agent.data()?.deletedAt,
        404,
        "record_not_found",
      );
      const exportState = await transaction.get(
        this.firestore.collection("agentExportState").doc(agentId),
      );
      requireAdmin(
        !exportState.data()?.pendingDeletions,
        409,
        "deletion_in_progress",
      );
      const stamp = Timestamp.fromDate(this.now());
      transaction.create(this.firestore.collection("adminJobs").doc(id), {
        kind: "export",
        exportEpoch: Number(exportState.data()?.epoch ?? 0),
        targetType: "agents",
        targetId: agentId,
        requestedBy: principal.operatorId,
        reason,
        requestedAt: stamp,
        updatedAt: stamp,
        phase: 0,
        processed: 0,
        cursor: null,
        status: "pending",
      });
      appendAdminAudit(
        this.firestore,
        transaction,
        principal,
        "export.requested",
        "agents",
        agentId,
        reason,
        this.now(),
        { jobId: id },
      );
    });
    await this.dispatch(id);
    return { id };
  }
  async dispatch(id: string) {
    requireAdmin(
      this.queue && this.objects,
      503,
      "durable_jobs_not_configured",
    );
    const ref = this.firestore.collection("adminJobs").doc(id);
    const job = (await ref.get()).data();
    requireAdmin(job, 404, "job_not_found");
    if (job.status === "completed") return;
    try {
      if (job.kind === "deletion") {
        await this.objects.writeLedger({
          id,
          targetType: job.targetType,
          targetId: job.targetId,
          requestedAt: job.requestedAt.toDate().toISOString(),
        });
        await ref.update({ ledgerRecordedAt: Timestamp.fromDate(this.now()) });
      }
      await this.queue.enqueue(id, randomUUID());
    } catch {
      await ref.update({
        status: "dispatch_failed",
        errorCode: "durable_dispatch_unavailable",
        updatedAt: Timestamp.fromDate(this.now()),
      });
    }
  }

  async step(id: string): Promise<void> {
    requireAdmin(
      this.objects && this.queue,
      503,
      "durable_jobs_not_configured",
    );
    const jobRef = this.firestore.collection("adminJobs").doc(id),
      saved = await jobRef.get(),
      job = saved.data();
    requireAdmin(job, 404, "job_not_found");
    if (job.status === "completed") return;
    try {
      if (job.kind === "deletion") {
        await this.objects.writeLedger({
          id,
          targetType: job.targetType,
          targetId: job.targetId,
          requestedAt: job.requestedAt.toDate().toISOString(),
        });
        if (Number(job.phase) === 0) {
          const target =
            job.targetType === "content"
              ? await this.firestore
                  .collection("publicItems")
                  .doc(job.targetId)
                  .get()
              : null;
          const agentId =
            job.exportAgentId ??
            (job.targetType === "agents"
              ? job.targetId
              : target?.data()?.authorId);
          if (
            agentId &&
            !(await this.objects.deleteArtifacts(`exports/${agentId}/`))
          ) {
            await this.queue.enqueue(id, randomUUID());
            return;
          }
        }
      }
      const phaseIndex = Number(job.phase),
        kind = job.kind;
      if (kind === "export") await this.exportStep(id, saved);
      else await this.deletionStep(id, saved);
      const updated = await jobRef.get();
      // Task delivery is at least once. Replays can enqueue extra bounded steps safely.
      if (updated.data()?.status !== "completed")
        await this.queue.enqueue(
          id,
          `${phaseIndex}-${digest(String(updated.data()?.cursor))}-${updated.data()?.processed}`,
        );
    } catch (error) {
      await this.firestore.runTransaction(async (transaction) => {
        const current = await transaction.get(jobRef);
        if (current.data()?.status !== "completed")
          transaction.update(jobRef, {
            status: "failed",
            errorCode: "job_step_failed",
            updatedAt: Timestamp.fromDate(this.now()),
          });
      });
      throw error;
    }
  }
  private async deletionStep(id: string, snapshot: DocumentSnapshot) {
    const job = snapshot.data()!;
    const phases =
      job.targetType === "agents"
        ? agentPhases
        : [
            {
              collection: "publicItems",
              field: "__name__",
              mode: "content" as const,
            },
          ];
    const phase = phases[job.phase];
    if (!phase) {
      await this.firestore.runTransaction(async (transaction) => {
        const current = await transaction.get(snapshot.ref);
        if (version(current) !== version(snapshot)) return;
        const profile =
          job.targetType === "agents"
            ? await transaction.get(
                this.firestore.collection("agentProfiles").doc(job.targetId),
              )
            : null;
        const at = this.now();
        if (job.targetType === "agents") {
          const profileRef = this.firestore
            .collection("agentProfiles")
            .doc(job.targetId);
          transaction.set(profileRef, {
            id: job.targetId,
            handle: `deleted_${digest(job.targetId).slice(0, 16)}`,
            displayName: "Deleted agent",
            description: null,
            status: "stopped",
            createdAt: profile?.data()?.createdAt ?? job.requestedAt,
            updatedAt: Timestamp.fromDate(at),
            deletedAt: Timestamp.fromDate(at),
          });
          for (const collection of [
            "agentAccess",
            "agentRecoveryKeys",
            "agentOperatorAuthority",
          ])
            transaction.delete(
              this.firestore.collection(collection).doc(job.targetId),
            );
        }
        if (job.exportAgentId)
          transaction.set(
            this.firestore
              .collection("agentExportState")
              .doc(job.exportAgentId),
            { pendingDeletions: FieldValue.increment(-1) },
            { merge: true },
          );
        transaction.update(snapshot.ref, {
          status: "completed",
          completedAt: Timestamp.fromDate(at),
          updatedAt: Timestamp.fromDate(at),
          errorCode: null,
        });
        appendAdminAudit(
          this.firestore,
          transaction,
          { operatorId: job.requestedBy },
          "deletion.completed",
          job.targetType,
          job.targetId,
          job.reason,
          at,
          { jobId: id },
        );
      });
      return;
    }
    let query: Query = this.firestore
      .collection(phase.collection)
      .where(
        phase.field === "__name__" ? FieldPath.documentId() : phase.field,
        "==",
        job.targetId,
      )
      .orderBy(FieldPath.documentId());
    if (job.cursor) query = query.startAfter(job.cursor);
    const records = await query.limit(CHUNK).get();
    await this.firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(snapshot.ref);
      if (version(current) !== version(snapshot)) return;
      const fresh = await Promise.all(
        records.docs.map((doc) => transaction.get(doc.ref)),
      );
      for (const record of fresh) {
        if (!record.exists) continue;
        if (phase.mode === "delete") transaction.delete(record.ref);
        else transaction.set(record.ref, contentMarker(record, this.now()));
      }
      transaction.update(snapshot.ref, {
        status: "running",
        phase: records.size < CHUNK ? job.phase + 1 : job.phase,
        cursor: records.size < CHUNK ? null : records.docs.at(-1)!.id,
        processed: job.processed + records.size,
        updatedAt: Timestamp.fromDate(this.now()),
        errorCode: null,
      });
    });
  }
  private async exportStep(id: string, snapshot: DocumentSnapshot) {
    const job = snapshot.data()!;
    const agent = await this.firestore
      .collection("agentProfiles")
      .doc(job.targetId)
      .get();
    requireAdmin(
      agent.exists && !agent.data()?.deletingAt && !agent.data()?.deletedAt,
      409,
      "agent_unavailable",
    );
    let query = this.firestore
      .collection("publicItems")
      .where("authorId", "==", job.targetId)
      .orderBy(FieldPath.documentId());
    if (job.cursor) query = query.startAfter(job.cursor);
    const records = await query.limit(CHUNK).get();
    const part = `exports/${job.targetId}/${id}/part-${job.phase}.json`;
    await this.objects!.writeArtifact(part, {
      formatVersion: 1,
      agent: project("agents", agent),
      items: records.docs
        .filter((doc) => !doc.data().deletedAt && !doc.data().deletingAt)
        .map((doc) => project("content", doc)),
    });
    await this.firestore.runTransaction(async (transaction) => {
      const [current, profile] = await Promise.all([
        transaction.get(snapshot.ref),
        transaction.get(agent.ref),
      ]);
      requireAdmin(
        profile.exists &&
          !profile.data()?.deletingAt &&
          !profile.data()?.deletedAt,
        409,
        "agent_unavailable",
      );
      if (version(current) !== version(snapshot)) return;
      const completed = records.size < CHUNK;
      transaction.update(snapshot.ref, {
        status: completed ? "completed" : "running",
        phase: job.phase + 1,
        cursor: records.docs.at(-1)?.id ?? null,
        processed: job.processed + records.size,
        updatedAt: Timestamp.fromDate(this.now()),
        ...(completed
          ? {
              completedAt: Timestamp.fromDate(this.now()),
              result: {
                formatVersion: 1,
                parts: job.phase + 1,
                prefix: `exports/${job.targetId}/${id}/`,
              },
            }
          : {}),
      });
      if (completed)
        appendAdminAudit(
          this.firestore,
          transaction,
          { operatorId: job.requestedBy },
          "export.completed",
          "agents",
          job.targetId,
          job.reason,
          this.now(),
          { jobId: id },
        );
    });
  }
  async download(id: string, part: number): Promise<unknown> {
    const job = await this.firestore.collection("adminJobs").doc(id).get();
    requireAdmin(
      job.data()?.kind === "export" &&
        job.data()?.status === "completed" &&
        Number.isInteger(part) &&
        part >= 0 &&
        part < job.data()?.result?.parts,
      404,
      "artifact_not_found",
    );
    const profile = await this.firestore
      .collection("agentProfiles")
      .doc(job.data()!.targetId)
      .get();
    requireAdmin(
      profile.exists &&
        !profile.data()?.deletedAt &&
        !profile.data()?.deletingAt,
      410,
      "artifact_unavailable",
    );
    const state = await this.firestore
      .collection("agentExportState")
      .doc(job.data()!.targetId)
      .get();
    requireAdmin(
      !state.data()?.pendingDeletions &&
        Number(state.data()?.epoch ?? 0) ===
          Number(job.data()?.exportEpoch ?? 0),
      410,
      "artifact_unavailable",
    );
    return this.objects!.readArtifact(
      `exports/${job.data()!.targetId}/${id}/part-${part}.json`,
    );
  }
}
