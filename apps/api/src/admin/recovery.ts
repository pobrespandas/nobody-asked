import { randomUUID } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import { digest, requireAdmin } from "./contracts.js";
import { AdminJobs, type JobObjects, type LedgerEntry } from "./jobs.js";

/** Run only against an isolated restored database while source writes are paused. */
export async function reconcileDeletionLedger(
  firestore: Firestore,
  objects: JobObjects,
  now = () => new Date(),
): Promise<{ applied: number; fingerprint: string; recoveryId: string }> {
  const recoveryId = randomUUID();
  const gate = firestore.collection("_operations").doc("deletionRecovery");
  await gate.set({ ready: false, startedAt: Timestamp.fromDate(now()) });
  const entries: LedgerEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await objects.listLedger(cursor);
    for (const entry of page.items) {
      requireAdmin(
        ["agents", "content"].includes(entry.targetType) &&
          /^[a-zA-Z0-9_.:@-]{1,180}$/.test(entry.targetId) &&
          Number.isFinite(Date.parse(entry.requestedAt)),
        500,
        "invalid_ledger_entry",
      );
      entries.push(entry);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const fingerprint = digest(
    JSON.stringify(
      entries
        .map((entry) => `${entry.id}:${entry.targetType}:${entry.targetId}`)
        .sort(),
    ),
  );
  const readonlyObjects: JobObjects = {
    ...objects,
    async deleteArtifacts() {
      return true;
    },
    async writeLedger(entry) {
      requireAdmin(
        entries.some(
          (saved) =>
            saved.targetType === entry.targetType &&
            saved.targetId === entry.targetId,
        ),
        500,
        "unrecorded_recovery_deletion",
      );
    },
  };
  const runner = new AdminJobs(
    firestore,
    readonlyObjects,
    { async enqueue() {} },
    now,
  );
  for (const entry of entries) {
    const target =
      entry.targetType === "content"
        ? await firestore.collection("publicItems").doc(entry.targetId).get()
        : null;
    const exportAgentId =
      entry.targetType === "agents" ? entry.targetId : target?.data()?.authorId;
    if (exportAgentId)
      await firestore
        .collection("agentExportState")
        .doc(exportAgentId)
        .set(
          { epoch: FieldValue.increment(1), pendingDeletions: 0 },
          { merge: true },
        );
    const jobId = `recovery-${digest(entry.id)}`;
    const ref = firestore.collection("adminJobs").doc(jobId);
    // Each recovery invocation starts from the restored records, not an old checkpoint.
    await ref.set({
      kind: "deletion",
      targetType: entry.targetType,
      targetId: entry.targetId,
      requestedAt: Timestamp.fromDate(new Date(entry.requestedAt)),
      requestedBy: "deletion-ledger-recovery",
      reason: "Apply the independent deletion ledger before traffic",
      phase: 0,
      processed: 0,
      cursor: null,
      status: "pending",
      updatedAt: Timestamp.fromDate(now()),
    });
    let completed = false;
    for (let step = 0; step < 100000; step++) {
      await runner.step(jobId);
      if ((await ref.get()).data()?.status === "completed") {
        completed = true;
        break;
      }
    }
    requireAdmin(completed, 500, "reconciliation_step_limit");
  }
  // Detect a ledger changed during the run. The caller must pause source writes.
  const after: string[] = [];
  cursor = undefined;
  do {
    const page = await objects.listLedger(cursor);
    after.push(
      ...page.items.map(
        (entry) => `${entry.id}:${entry.targetType}:${entry.targetId}`,
      ),
    );
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  requireAdmin(
    digest(JSON.stringify(after.sort())) === fingerprint,
    409,
    "ledger_changed_retry_reconciliation",
  );
  await gate.set({
    ready: true,
    recoveryId,
    databaseId: firestore.databaseId,
    applied: entries.length,
    fingerprint,
    verifiedAt: Timestamp.fromDate(now()),
  });
  return { applied: entries.length, fingerprint, recoveryId };
}
export async function assertRecoveryGate(
  firestore: Firestore,
  now = new Date(),
  expectedRecoveryId?: string,
): Promise<void> {
  const gate = await firestore
    .collection("_operations")
    .doc("deletionRecovery")
    .get();
  requireAdmin(
    gate.data()?.ready === true &&
      gate.data()?.databaseId === firestore.databaseId &&
      (!expectedRecoveryId || gate.data()?.recoveryId === expectedRecoveryId) &&
      gate.data()?.verifiedAt &&
      (gate.data()?.activatedAt ||
        now.getTime() - gate.data()!.verifiedAt.toMillis() < 600000),
    503,
    "deletion_recovery_not_verified",
  );
}

export async function activateRecoveryGate(
  firestore: Firestore,
  recoveryId: string,
  now = new Date(),
): Promise<void> {
  await firestore.runTransaction(async (transaction) => {
    const ref = firestore.collection("_operations").doc("deletionRecovery");
    const gate = await transaction.get(ref);
    requireAdmin(
      gate.data()?.ready === true &&
        gate.data()?.databaseId === firestore.databaseId &&
        gate.data()?.recoveryId === recoveryId &&
        now.getTime() - gate.data()!.verifiedAt.toMillis() < 600000,
      503,
      "deletion_recovery_not_verified",
    );
    transaction.update(ref, { activatedAt: Timestamp.fromDate(now) });
  });
}
