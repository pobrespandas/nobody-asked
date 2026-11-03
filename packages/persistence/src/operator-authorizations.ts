import { createHash, timingSafeEqual } from "node:crypto";
import {
  FieldValue,
  Timestamp,
  type DocumentData,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {
  AgentProofRejectedError,
  OperatorAuthenticationRejectedError,
} from "@nobody-asked/access";
import {
  AgentWriteBlockedError,
  CredentialWriteBlockedError,
  IdempotencyRequestConflictError,
  RateLimitExceededError,
  type AcceptAgentOperatorAuthorizationInput,
  type AgentOperatorAuthorizationAuthentication,
  type AgentOperatorAuthorizationState,
  type CreateAgentOperatorAuthorizationInput,
  type RemoveAgentOperatorAuthorizationInput,
  type StoredResponseRecord,
} from "./contracts.js";

export class OperatorAuthorizationUnavailableError extends Error {
  readonly code = "operator_authorization_unavailable";
  constructor() {
    super("Operator authorization is unavailable.");
  }
}
export class OperatorAuthorizationConflictError extends Error {
  readonly code = "operator_authorization_conflict";
  constructor() {
    super("Read the current Operator authorization and submit a new command.");
  }
}

export type AuthorizationAudit = (
  transaction: Transaction,
  event: {
    agentId: string;
    actorId: string;
    operator: boolean;
    action:
      | "operator.authorization_requested"
      | "operator.authorization_accepted"
      | "operator.authorization_removed";
    at: Date;
    correlationId: string;
  },
) => void;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const date = (value: unknown): Date =>
  value instanceof Timestamp ? value.toDate() : (value as Date);
const equal = (left: string, right: string) => {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const token = (value: string) => {
  const point = value.indexOf(".");
  if (point < 1 || point === value.length - 1)
    throw new CredentialWriteBlockedError();
  return { id: value.slice(0, point), secret: value.slice(point + 1) };
};
export const authorityRevision = (data: DocumentData | undefined) =>
  Number(data?.revision ?? 0);

export async function readAuthorityRemoval(
  firestore: Firestore,
  transaction: Transaction,
  agentId: string,
  authority?: DocumentData,
) {
  const ref = firestore.collection("agentOperatorAuthority").doc(agentId);
  const value = authority ?? (await transaction.get(ref)).data();
  const ids = [
    ...new Set(
      [value?.pendingAuthorizationId, value?.activeAuthorizationId].filter(
        (id): id is string => typeof id === "string",
      ),
    ),
  ];
  const records = await Promise.all(
    ids.map((id) =>
      transaction.get(
        firestore.collection("agentOperatorAuthorizations").doc(id),
      ),
    ),
  );
  return { ref, value, records };
}

export function writeAuthorityRemoval(
  transaction: Transaction,
  state: Awaited<ReturnType<typeof readAuthorityRemoval>>,
  agentId: string,
  at: Date,
) {
  const revision = authorityRevision(state.value) + 1;
  for (const record of state.records)
    if (record.exists)
      transaction.update(record.ref, { revokedAt: Timestamp.fromDate(at) });
  transaction.set(state.ref, {
    agentId,
    revision,
    pendingAuthorizationId: null,
    operatorId: null,
    activeAuthorizationId: null,
    updatedAt: Timestamp.fromDate(at),
  });
  transaction.update(
    state.ref.firestore.collection("agentProfiles").doc(agentId),
    { controllingOperatorId: FieldValue.delete() },
  );
  return revision;
}

export async function readAuthorizationRate(
  firestore: Firestore,
  transaction: Transaction,
  actorId: string,
  command: "create" | "accept" | "remove",
  at: Date,
) {
  const start = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const resetAt = new Date(start.getTime() + 60_000);
  const ref = firestore
    .collection("rateLimitBuckets")
    .doc(
      hash(
        JSON.stringify([
          actorId,
          "operator-authorization",
          command,
          start.toISOString(),
        ]),
      ),
    );
  const snapshot = await transaction.get(ref);
  const count = Number(snapshot.data()?.count ?? 0);
  if (count >= (command === "remove" ? 30 : 10))
    throw new RateLimitExceededError(resetAt);
  return {
    ref,
    data: {
      actorId,
      actorKind: command === "accept" ? "operator" : "agent",
      command: `operator_authorization.${command}`,
      windowStartedAt: Timestamp.fromDate(start),
      count: count + 1,
      resetAt: Timestamp.fromDate(resetAt),
      expireAt: Timestamp.fromDate(new Date(resetAt.getTime() + 86_400_000)),
    },
  };
}

export class FirestoreOperatorAuthorizations {
  constructor(
    private readonly firestore: Firestore,
    private readonly digest: (secret: string) => string | Promise<string>,
    private readonly audit: AuthorizationAudit,
  ) {}

  private async authenticated(
    transaction: Transaction,
    input: AgentOperatorAuthorizationAuthentication,
    digest: string,
  ) {
    const credential = token(input.credentialSecret);
    if (credential.id !== input.credentialId)
      throw new CredentialWriteBlockedError();
    const [stored, profile, access] = await Promise.all([
      transaction.get(
        this.firestore.collection("credentials").doc(input.credentialId),
      ),
      transaction.get(
        this.firestore
          .collection("agentProfiles")
          .doc(input.authenticatedAgentId),
      ),
      transaction.get(
        this.firestore
          .collection("agentAccess")
          .doc(input.authenticatedAgentId),
      ),
    ]);
    const value = stored.data();
    if (
      !value ||
      value.agentId !== input.authenticatedAgentId ||
      !equal(String(value.secretDigest ?? ""), digest) ||
      value.revokedAt ||
      (value.expiresAt && date(value.expiresAt) <= input.occurredAt) ||
      access.data()?.activeCredentialId !== input.credentialId ||
      access.data()?.stopped === true
    )
      throw new CredentialWriteBlockedError();
    if (!profile.exists || profile.data()?.status !== "active")
      throw new AgentWriteBlockedError(
        profile.data()?.status === "stopped" ? "stopped" : "suspended",
      );
    const authority = await transaction.get(
      this.firestore
        .collection("agentOperatorAuthority")
        .doc(input.authenticatedAgentId),
    );
    if (!authority.exists && profile.data()?.controllingOperatorId)
      throw new OperatorAuthorizationUnavailableError();
    return authority;
  }

  async read(
    input: AgentOperatorAuthorizationAuthentication,
  ): Promise<AgentOperatorAuthorizationState> {
    const digest = await this.digest(token(input.credentialSecret).secret);
    return this.firestore.runTransaction(
      async (transaction) => {
        const authority = await this.authenticated(transaction, input, digest);
        const value = authority.data();
        const authorizationId =
          value?.pendingAuthorizationId ?? value?.activeAuthorizationId;
        const authorization = authorizationId
          ? await transaction.get(
              this.firestore
                .collection("agentOperatorAuthorizations")
                .doc(String(authorizationId)),
            )
          : null;
        const record = authorization?.data();
        return {
          agentId: input.authenticatedAgentId,
          revision: authorityRevision(value),
          authorization: record
            ? {
                authorizationId: String(authorizationId),
                operatorId: String(record.operatorId),
                status: value?.activeAuthorizationId ? "active" : "pending",
                expiresAt: value?.activeAuthorizationId
                  ? null
                  : date(record.expiresAt).toISOString(),
              }
            : null,
        };
      },
      { readOnly: true },
    );
  }

  async create(input: CreateAgentOperatorAuthorizationInput) {
    return this.agentCommand(input, "create");
  }
  async remove(input: RemoveAgentOperatorAuthorizationInput) {
    return this.agentCommand(input, "remove");
  }

  private async agentCommand(
    input:
      | CreateAgentOperatorAuthorizationInput
      | RemoveAgentOperatorAuthorizationInput,
    operation: "create" | "remove",
  ): Promise<{ response: StoredResponseRecord }> {
    const digest = await this.digest(token(input.credentialSecret).secret);
    const fingerprint = JSON.stringify({
      operation,
      ifRevision: input.ifRevision,
      ...("operatorId" in input ? { operatorId: input.operatorId } : {}),
    });
    const commandRef = this.firestore
      .collection("idempotencyRecords")
      .doc(
        hash(
          JSON.stringify([
            input.authenticatedAgentId,
            `operator-authorization:${operation}`,
            input.idempotencyKey,
          ]),
        ),
      );
    return this.firestore.runTransaction(async (transaction) => {
      const authority = await this.authenticated(transaction, input, digest);
      const prior = await transaction.get(commandRef);
      if (prior.exists) return replay(prior.data()!, fingerprint);
      const value = authority.data();
      if (
        !Number.isSafeInteger(input.ifRevision) ||
        input.ifRevision < 0 ||
        authorityRevision(value) !== input.ifRevision
      )
        throw new OperatorAuthorizationConflictError();
      const rate = await readAuthorizationRate(
        this.firestore,
        transaction,
        input.authenticatedAgentId,
        operation,
        input.occurredAt,
      );
      const revision = input.ifRevision + 1;
      let response: StoredResponseRecord;
      if (operation === "create") {
        const create = input as CreateAgentOperatorAuthorizationInput;
        const operator = await transaction.get(
          this.firestore.collection("operators").doc(create.operatorId),
        );
        const requestRef = this.firestore
          .collection("agentOperatorAuthorizations")
          .doc(create.authorizationId);
        const request = await transaction.get(requestRef);
        if (
          !eligibleOperator(operator.data()) ||
          request.exists ||
          value?.pendingAuthorizationId ||
          value?.operatorId ||
          value?.activeAuthorizationId
        )
          throw new OperatorAuthorizationUnavailableError();
        const expiresAt = new Date(input.occurredAt.getTime() + 600_000);
        transaction.create(requestRef, {
          agentId: input.authenticatedAgentId,
          operatorId: create.operatorId,
          revision,
          requestedAt: Timestamp.fromDate(input.occurredAt),
          expiresAt: Timestamp.fromDate(expiresAt),
          acceptedAt: null,
          revokedAt: null,
          requesterCredentialId: input.credentialId,
        });
        transaction.set(authority.ref, {
          agentId: input.authenticatedAgentId,
          revision,
          pendingAuthorizationId: create.authorizationId,
          operatorId: null,
          activeAuthorizationId: null,
          updatedAt: Timestamp.fromDate(input.occurredAt),
        });
        response = {
          status: 201,
          body: {
            data: {
              agentId: input.authenticatedAgentId,
              authorizationId: create.authorizationId,
              revision,
              requestedAt: input.occurredAt.toISOString(),
              expiresAt: expiresAt.toISOString(),
            },
          },
        };
      } else {
        const state = await readAuthorityRemoval(
          this.firestore,
          transaction,
          input.authenticatedAgentId,
          value,
        );
        writeAuthorityRemoval(
          transaction,
          state,
          input.authenticatedAgentId,
          input.occurredAt,
        );
        response = {
          status: 200,
          body: {
            data: {
              agentId: input.authenticatedAgentId,
              revision,
              removedAt: input.occurredAt.toISOString(),
            },
          },
        };
      }
      transaction.set(rate.ref, rate.data);
      this.audit(transaction, {
        agentId: input.authenticatedAgentId,
        actorId: input.authenticatedAgentId,
        operator: false,
        action:
          operation === "create"
            ? "operator.authorization_requested"
            : "operator.authorization_removed",
        at: input.occurredAt,
        correlationId: input.correlationId,
      });
      saveCommand(
        transaction,
        commandRef,
        fingerprint,
        input.idempotencyKey,
        input.authenticatedAgentId,
        `operator-authorization:${operation}`,
        response,
        input.occurredAt,
      );
      return { response };
    });
  }

  async accept(
    input: AcceptAgentOperatorAuthorizationInput,
  ): Promise<{ response: StoredResponseRecord }> {
    const sessionToken = token(input.sessionSecret);
    const digest = await this.digest(sessionToken.secret);
    const fingerprint = JSON.stringify({
      authorizationId: input.authorizationId,
    });
    const commandRef = this.firestore
      .collection("idempotencyRecords")
      .doc(
        hash(
          JSON.stringify([
            input.operatorId,
            "operator-authorization:accept",
            input.idempotencyKey,
          ]),
        ),
      );
    return this.firestore.runTransaction(async (transaction) => {
      const [session, operator, request, prior] = await Promise.all([
        transaction.get(
          this.firestore.collection("operatorSessions").doc(sessionToken.id),
        ),
        transaction.get(
          this.firestore.collection("operators").doc(input.operatorId),
        ),
        transaction.get(
          this.firestore
            .collection("agentOperatorAuthorizations")
            .doc(input.authorizationId),
        ),
        transaction.get(commandRef),
      ]);
      const sessionData = session.data();
      if (
        !sessionData ||
        !eligibleOperator(operator.data()) ||
        sessionData.operatorId !== input.operatorId ||
        sessionData.origin !== input.origin ||
        !equal(String(sessionData.secretDigest ?? ""), digest) ||
        sessionData.revokedAt ||
        !sessionData.expiresAt ||
        date(sessionData.expiresAt) <= input.occurredAt ||
        !sessionData.authenticatedAt ||
        input.occurredAt.getTime() -
          date(sessionData.authenticatedAt).getTime() >
          600_000 ||
        date(sessionData.authenticatedAt) > input.occurredAt
      )
        throw new OperatorAuthenticationRejectedError();
      if (prior.exists) return replay(prior.data()!, fingerprint);
      const value = request.data();
      if (
        !value ||
        value.operatorId !== input.operatorId ||
        value.revokedAt ||
        value.acceptedAt ||
        !value.expiresAt ||
        date(value.expiresAt) <= input.occurredAt
      )
        throw new OperatorAuthorizationUnavailableError();
      const agentId = String(value.agentId);
      const [authority, profile, access] = await Promise.all([
        transaction.get(
          this.firestore.collection("agentOperatorAuthority").doc(agentId),
        ),
        transaction.get(
          this.firestore.collection("agentProfiles").doc(agentId),
        ),
        transaction.get(this.firestore.collection("agentAccess").doc(agentId)),
      ]);
      const state = authority.data();
      if (
        !profile.exists ||
        profile.data()?.status !== "active" ||
        access.data()?.stopped === true ||
        profile.data()?.controllingOperatorId ||
        state?.pendingAuthorizationId !== input.authorizationId ||
        authorityRevision(state) !== Number(value.revision) ||
        state?.operatorId ||
        state?.activeAuthorizationId
      )
        throw new OperatorAuthorizationUnavailableError();
      const rate = await readAuthorizationRate(
        this.firestore,
        transaction,
        input.operatorId,
        "accept",
        input.occurredAt,
      );
      const revision = authorityRevision(state) + 1;
      transaction.update(authority.ref, {
        revision,
        pendingAuthorizationId: null,
        operatorId: input.operatorId,
        activeAuthorizationId: input.authorizationId,
        updatedAt: Timestamp.fromDate(input.occurredAt),
      });
      transaction.update(request.ref, {
        acceptedAt: Timestamp.fromDate(input.occurredAt),
      });
      transaction.update(profile.ref, {
        controllingOperatorId: input.operatorId,
      });
      transaction.set(rate.ref, rate.data);
      const response: StoredResponseRecord = {
        status: 200,
        body: {
          data: {
            agentId,
            authorizationId: input.authorizationId,
            revision,
            acceptedAt: input.occurredAt.toISOString(),
          },
        },
      };
      this.audit(transaction, {
        agentId,
        actorId: input.operatorId,
        operator: true,
        action: "operator.authorization_accepted",
        at: input.occurredAt,
        correlationId: input.correlationId,
      });
      saveCommand(
        transaction,
        commandRef,
        fingerprint,
        input.idempotencyKey,
        input.operatorId,
        "operator-authorization:accept",
        response,
        input.occurredAt,
      );
      return { response };
    });
  }
}

function eligibleOperator(data: DocumentData | undefined) {
  return Boolean(
    data && data.active !== false && !data.revokedAt && !data.disabledAt,
  );
}
function replay(data: DocumentData, fingerprint: string) {
  if (data.requestFingerprint !== fingerprint)
    throw new IdempotencyRequestConflictError();
  return { response: data.response as StoredResponseRecord };
}
function saveCommand(
  transaction: Transaction,
  ref: FirebaseFirestore.DocumentReference,
  fingerprint: string,
  key: string,
  actorId: string,
  command: string,
  response: StoredResponseRecord,
  at: Date,
) {
  transaction.create(ref, {
    actorId,
    command,
    keyHash: hash(key),
    requestFingerprint: fingerprint,
    response,
    completedAt: Timestamp.fromDate(at),
    expireAt: Timestamp.fromDate(new Date(at.getTime() + 30 * 86_400_000)),
  });
}
