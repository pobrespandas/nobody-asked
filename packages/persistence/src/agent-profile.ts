import { createHash, randomUUID } from "node:crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  validateProfilePatch,
  type AgentProfilePatch,
} from "@nobody-asked/identity";
import {
  credentialIsActive,
  constantTimeEqual,
  parseCredentialToken,
} from "./credential-state.js";

export class ProfileOperationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAt?: string,
  ) {
    super(code);
  }
}
export interface ProfileCaller {
  agentId: string;
  credentialId: string;
  token: string;
  at: Date;
}
export interface ProfileSnapshot {
  profile: Record<string, unknown>;
  version: string;
}
export interface AgentProfileOperations {
  read(caller: ProfileCaller): Promise<ProfileSnapshot>;
  update(
    caller: ProfileCaller,
    patch: AgentProfilePatch,
    version: string,
    key: string,
  ): Promise<ProfileSnapshot>;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function requireProfile(
  condition: unknown,
  status: number,
  code: string,
): asserts condition {
  if (!condition) throw new ProfileOperationError(status, code);
}

export class FirestoreAgentProfiles implements AgentProfileOperations {
  constructor(
    readonly firestore: Firestore,
    readonly digestSecret: (secret: string) => string | Promise<string>,
  ) {}
  async read(caller: ProfileCaller): Promise<ProfileSnapshot> {
    return this.execute(caller);
  }
  async update(
    caller: ProfileCaller,
    patch: AgentProfilePatch,
    version: string,
    key: string,
  ): Promise<ProfileSnapshot> {
    return this.execute(caller, {
      patch: validateProfilePatch(patch),
      version,
      key,
    });
  }
  private async execute(
    caller: ProfileCaller,
    command?: { patch: AgentProfilePatch; version: string; key: string },
  ): Promise<ProfileSnapshot> {
    const parsed = parseCredentialToken(caller.token);
    requireProfile(
      parsed?.credentialId === caller.credentialId,
      401,
      "invalid_credential",
    );
    const secret = await this.digestSecret(parsed.secret);
    const profileRef = this.firestore
      .collection("agentProfiles")
      .doc(caller.agentId);
    const stamp = Timestamp.fromDate(caller.at);
    return this.firestore.runTransaction(async (transaction) => {
      const [profile, credential, access] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(
          this.firestore.collection("credentials").doc(caller.credentialId),
        ),
        transaction.get(
          this.firestore.collection("agentAccess").doc(caller.agentId),
        ),
      ]);
      const cd = credential.data(),
        data = profile.data();
      requireProfile(
        profile.exists &&
          !data?.deletedAt &&
          !data?.deletingAt &&
          cd?.agentId === caller.agentId &&
          credentialIsActive(cd, caller.at) &&
          constantTimeEqual(String(cd?.secretDigest ?? ""), secret) &&
          access.data()?.activeCredentialId === caller.credentialId &&
          !access.data()?.stopped,
        401,
        "invalid_credential",
      );
      requireProfile(
        data?.status === "active",
        403,
        data?.status === "stopped" ? "agent_stopped" : "agent_suspended",
      );
      const result: ProfileSnapshot = {
        profile: Object.fromEntries(
          [
            "id",
            "handle",
            "displayName",
            "description",
            "status",
            "createdAt",
            "updatedAt",
          ].map((field) => {
            const value = field === "id" ? profile.id : data[field];
            return [
              field,
              value instanceof Timestamp
                ? value.toDate().toISOString()
                : (value ?? null),
            ];
          }),
        ),
        version: String(
          data.profileVersion ??
            `${profile.updateTime!.seconds}.${profile.updateTime!.nanoseconds}`,
        ),
      };
      if (!command) return result;
      const commandRef = this.firestore
        .collection("idempotencyRecords")
        .doc(hash(`profile:${caller.agentId}:${command.key}`));
      const fingerprint = hash(
        JSON.stringify({
          version: command.version,
          displayName: command.patch.displayName,
          description: command.patch.description,
        }),
      );
      const saved = await transaction.get(commandRef);
      if (saved.exists) {
        requireProfile(
          saved.data()?.fingerprint === fingerprint,
          409,
          "idempotency_conflict",
        );
        return saved.data()!.response as ProfileSnapshot;
      }
      requireProfile(
        command.version === result.version,
        409,
        "record_conflict",
      );
      const rateRef = this.firestore
        .collection("rateLimitBuckets")
        .doc(hash(`profile.update:${caller.agentId}`));
      const rate = await transaction.get(rateRef),
        bucket = Math.floor(caller.at.getTime() / 60000);
      const count =
        rate.data()?.bucket === bucket ? Number(rate.data()?.count ?? 0) : 0;
      if (count >= 10)
        throw new ProfileOperationError(
          429,
          "rate_limit_exceeded",
          new Date((bucket + 1) * 60000).toISOString(),
        );
      const version = randomUUID();
      const response = {
        profile: {
          ...result.profile,
          ...command.patch,
          updatedAt: caller.at.toISOString(),
        },
        version,
      };
      transaction.update(profileRef, {
        ...command.patch,
        updatedAt: stamp,
        profileVersion: version,
      });
      transaction.set(rateRef, {
        agentId: caller.agentId,
        bucket,
        count: count + 1,
        expireAt: Timestamp.fromMillis((bucket + 2) * 60000),
      });
      transaction.create(commandRef, {
        agentId: caller.agentId,
        fingerprint,
        response,
        createdAt: stamp,
        expireAt: Timestamp.fromMillis(caller.at.getTime() + 30 * 86400000),
      });
      transaction.create(
        this.firestore
          .collection("auditRecords")
          .doc(hash(`profile-audit:${commandRef.id}`)),
        {
          actorType: "agent",
          actorId: caller.agentId,
          action: "agent.profile_updated",
          subjectType: "agent",
          subjectId: caller.agentId,
          details: {
            result: "completed",
            changedFields: Object.keys(command.patch),
            reasonCategory: null,
            previousState: null,
            resultingState: null,
            correlationId: randomUUID(),
            credentialId: caller.credentialId,
            requestOrigin: null,
            retentionRange: null,
          },
          createdAt: stamp,
          expireAt: Timestamp.fromMillis(caller.at.getTime() + 365 * 86400000),
        },
      );
      return response;
    });
  }
}
