import { randomUUID } from "node:crypto";
import {
  Timestamp,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {
  moderationAgentTransition,
  moderationContentTransition,
} from "@nobody-asked/safety";
import {
  digest,
  requireAdmin,
  resources,
  version,
  type ActionInput,
  type Principal,
} from "./contracts.js";

export function appendAdminAudit(
  firestore: Firestore,
  transaction: Transaction,
  principal: Pick<Principal, "operatorId">,
  action: string,
  subjectType: string,
  subjectId: string,
  reason: string,
  at: Date,
  extra: Record<string, unknown> = {},
): string {
  const ref = firestore.collection("auditRecords").doc();
  transaction.create(ref, {
    actorType: "administrator",
    actorId: principal.operatorId,
    action,
    subjectType,
    subjectId,
    createdAt: Timestamp.fromDate(at),
    expireAt: Timestamp.fromMillis(at.getTime() + 365 * 86400000),
    details: { result: "completed", reason, ...extra },
  });
  return ref.id;
}
export async function assertPrincipal(
  firestore: Firestore,
  transaction: Transaction,
  principal: Principal,
  now: Date,
  recent = true,
): Promise<void> {
  const [session, authority] = await Promise.all([
    transaction.get(
      firestore.collection("operatorSessions").doc(principal.sessionId),
    ),
    transaction.get(
      firestore
        .collection("administratorAuthorities")
        .doc(principal.operatorId),
    ),
  ]);
  requireAdmin(
    session.exists &&
      !session.data()?.revokedAt &&
      session.data()?.operatorId === principal.operatorId &&
      session.data()?.expiresAt.toMillis() > now.getTime() &&
      authority.exists &&
      !authority.data()?.revokedAt,
    403,
    "administrator_required",
  );
  const bindingId = session.data()?.adminGoogleBinding;
  requireAdmin(typeof bindingId === "string", 403, "administrator_required");
  const [binding, operator] = await Promise.all([
    transaction.get(
      firestore.collection("administratorBindings").doc(bindingId),
    ),
    transaction.get(
      firestore.collection("operators").doc(principal.operatorId),
    ),
  ]);
  requireAdmin(
    binding.exists &&
      !binding.data()?.revokedAt &&
      binding.data()?.operatorId === principal.operatorId &&
      operator.exists &&
      operator.data()?.active !== false &&
      !operator.data()?.disabledAt &&
      !operator.data()?.revokedAt,
    403,
    "administrator_required",
  );
  requireAdmin(
    !recent ||
      (now.getTime() - session.data()!.authenticatedAt.toMillis() >= 0 &&
        now.getTime() - session.data()!.authenticatedAt.toMillis() < 600000),
    403,
    "recent_authentication_required",
  );
}
export class AdminActions {
  constructor(
    readonly firestore: Firestore,
    readonly now = () => new Date(),
  ) {}
  async execute(
    principal: Principal,
    input: ActionInput,
  ): Promise<{ id: string; auditId: string; replay?: boolean }> {
    requireAdmin(input.action !== "delete", 400, "use_deletion_request");
    const fingerprint = digest(JSON.stringify(input));
    const command = this.firestore
      .collection("adminCommands")
      .doc(digest(`${principal.operatorId}:${input.key}`));
    return this.firestore.runTransaction(async (transaction) => {
      await assertPrincipal(this.firestore, transaction, principal, this.now());
      const saved = await transaction.get(command);
      if (saved.exists) {
        requireAdmin(
          saved.data()?.fingerprint === fingerprint,
          409,
          "idempotency_conflict",
        );
        return { ...saved.data()!.result, replay: true };
      }
      let target = this.firestore
        .collection(resources[input.resource].collection)
        .doc(input.id);
      let snapshot = await transaction.get(target);
      requireAdmin(snapshot.exists, 404, "record_not_found");
      requireAdmin(version(snapshot) === input.version, 409, "record_conflict");
      let report: FirebaseFirestore.DocumentSnapshot | null = null;
      let scope = input.resource;
      let operation = input.action;
      if (input.resource === "reports" && input.action === "resolve") {
        requireAdmin(
          !snapshot.data()?.resolvedAt,
          409,
          "report_already_resolved",
        );
        report = snapshot;
        const subject = snapshot.data()?.target;
        requireAdmin(
          subject && ["agent_profile", "public_item"].includes(subject.type),
          409,
          "invalid_report_target",
        );
        scope = subject.type === "agent_profile" ? "agents" : "content";
        operation = subject.type === "agent_profile" ? "suspend" : "hide";
        target = this.firestore
          .collection(resources[scope].collection)
          .doc(String(subject.id));
        snapshot = await transaction.get(target);
        requireAdmin(snapshot.exists, 404, "report_target_not_found");
        requireAdmin(
          input.subjectVersion === version(snapshot),
          409,
          "record_conflict",
        );
      }
      const data = snapshot.data()!;
      requireAdmin(
        !data.deletingAt && !data.deletedAt,
        409,
        "deletion_in_progress",
      );
      const at = this.now(),
        stamp = Timestamp.fromDate(at);
      let patch: Record<string, unknown>;
      let action: string;
      let credentialRefs: FirebaseFirestore.DocumentReference[] = [];
      if (
        scope === "agents" &&
        ["suspend", "restore", "revoke"].includes(operation)
      ) {
        const credentials = await transaction.get(
          this.firestore
            .collection("credentials")
            .where("agentId", "==", target.id)
            .where("revokedAt", "==", null),
        );
        requireAdmin(
          credentials.size <= 100,
          409,
          "credential_invariant_failed",
        );
        credentialRefs =
          operation === "restore"
            ? []
            : credentials.docs
                .filter((doc) => !doc.data().revokedAt)
                .map((doc) => doc.ref);
        requireAdmin(
          operation !== "restore" ||
            data.status !== "suspended" ||
            ["active", "stopped"].includes(data.statusBeforeSuspension),
          409,
          "previous_activity_state_unavailable",
        );
        const next = moderationAgentTransition(
          data.status,
          operation === "restore" ? "restore" : "suspend",
          data.statusBeforeSuspension,
        );
        if (operation === "revoke") {
          patch = {};
          action = "credential.revoked_all";
        } else {
          patch = {
            status: next.status,
            statusBeforeSuspension: next.statusBeforeSuspension,
            moderationReasonCategory: input.category,
            moderatedAt: stamp,
            updatedAt: stamp,
          };
          action =
            operation === "suspend"
              ? "agent.suspended"
              : "agent.moderator_restored";
        }
      } else if (
        scope === "content" &&
        ["hide", "restore"].includes(operation)
      ) {
        patch = {
          visibility: moderationContentTransition(
            data.visibility,
            operation as "hide" | "restore",
          ).visibility,
          moderationReasonCategory: input.category,
          moderatedAt: stamp,
        };
        action = operation === "hide" ? "content.hidden" : "content.restored";
      } else if (
        ["credentials", "sessions", "invitations"].includes(input.resource) &&
        operation === "revoke"
      ) {
        requireAdmin(
          !(input.resource === "invitations" && data.acceptedAt),
          409,
          "invitation_already_accepted",
        );
        patch = { revokedAt: stamp };
        action = `${input.resource}.revoked`;
        if (input.resource === "credentials") {
          const access = await transaction.get(
            this.firestore.collection("agentAccess").doc(String(data.agentId)),
          );
          if (access.data()?.activeCredentialId === input.id)
            credentialRefs = [target];
        }
      } else if (input.resource === "reports" && input.action === "review") {
        requireAdmin(
          input.decision === "dismissed" && !data.resolvedAt,
          409,
          "invalid_report_review",
        );
        patch = {
          decision: "dismissed",
          resolvedAt: stamp,
          moderatorId: principal.operatorId,
          reviewReasonCategory: input.category,
          internalNote: input.reason,
        };
        action = "report.resolved";
      } else {
        requireAdmin(false, 400, "unsupported_action");
      }
      if (report) {
        transaction.update(report.ref, {
          decision: scope === "agents" ? "agent_suspended" : "content_hidden",
          resolvedAt: stamp,
          moderatorId: principal.operatorId,
          reviewReasonCategory: input.category,
          internalNote: input.reason,
        });
        appendAdminAudit(
          this.firestore,
          transaction,
          principal,
          "report.resolved",
          "reports",
          report.id,
          input.reason,
          at,
          { reasonCategory: input.category },
        );
      }
      if (Object.keys(patch!).length) transaction.update(target, patch!);
      for (const ref of credentialRefs)
        transaction.update(ref, { revokedAt: stamp });
      if (scope === "agents" && operation !== "restore")
        transaction.set(
          this.firestore.collection("agentAccess").doc(target.id),
          { activeCredentialId: null },
          { merge: true },
        );
      if (input.resource === "credentials" && credentialRefs.length)
        transaction.set(
          this.firestore.collection("agentAccess").doc(String(data.agentId)),
          { activeCredentialId: null },
          { merge: true },
        );
      const auditId = appendAdminAudit(
        this.firestore,
        transaction,
        principal,
        action!,
        scope,
        target.id,
        input.reason,
        at,
        {
          reasonCategory: input.category,
          previousState: Object.fromEntries(
            ["status", "visibility", "revokedAt"]
              .filter((key) => data[key] !== undefined)
              .map((key) => [
                key,
                key === "revokedAt" ? !!data[key] : data[key],
              ]),
          ),
          resultingState: Object.fromEntries(
            ["status", "visibility", "revokedAt"]
              .filter((key) => patch![key] !== undefined)
              .map((key) => [
                key,
                key === "revokedAt" ? !!patch![key] : patch![key],
              ]),
          ),
        },
      );
      if (scope === "agents" || scope === "content")
        transaction.create(
          this.firestore.collection("moderationActions").doc(randomUUID()),
          {
            subjectId: target.id,
            subjectType: scope === "agents" ? "agent" : "public_item",
            action: action!,
            moderatorId: principal.operatorId,
            reasonCategory: input.category,
            internalNote: input.reason,
            createdAt: stamp,
          },
        );
      const result = { id: input.id, auditId };
      transaction.create(command, {
        fingerprint,
        result,
        completedAt: stamp,
        expireAt: Timestamp.fromMillis(at.getTime() + 30 * 86400000),
      });
      return result;
    });
  }
}
