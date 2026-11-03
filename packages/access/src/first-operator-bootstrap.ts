import type { OperatorSessionRecord } from "./operator-session.js";

export interface OperatorInvitationRecord {
  readonly id: string;
  readonly intendedIdentity: string;
  readonly secretDigest: string;
  readonly expiresAt: Date;
  readonly recipientProofAt: Date | null;
  readonly acceptedAt: Date | null;
  readonly acceptedOperatorId: string | null;
  readonly revokedAt: Date | null;
}

export interface OperatorRecord {
  readonly id: string;
  readonly normalizedIdentity: string;
  readonly sourceInvitationId: string;
  readonly createdAt: Date;
  readonly active?: boolean;
  readonly revokedAt?: Date | null;
  readonly disabledAt?: Date | null;
}

export interface ModeratorAuthorityRecord {
  readonly operatorId: string;
  readonly grantedAt: Date;
  readonly source: "first_operator_bootstrap";
}

export interface FirstOperatorBootstrapRecord {
  readonly invitationId: string;
  readonly operatorId: string;
  readonly completedAt: Date;
}

export interface BootstrapAuditRecord {
  readonly id: string;
  readonly actorType: "system";
  readonly actorId: "deployment-bootstrap";
  readonly action: "operator.enrolled" | "moderator.authority_granted";
  readonly subjectType: "operator";
  readonly subjectId: string;
  readonly result: "completed";
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly expireAt: Date;
}

export interface FirstOperatorBootstrapState {
  readonly invitation: OperatorInvitationRecord | null;
  readonly bootstrap: FirstOperatorBootstrapRecord | null;
  readonly operator: OperatorRecord | null;
  readonly moderatorAuthority: ModeratorAuthorityRecord | null;
  readonly anyModeratorAuthority: ModeratorAuthorityRecord | null;
}

export interface FirstOperatorBootstrapTransaction {
  readSession?(sessionId: string): Promise<OperatorSessionRecord | null>;
  readState(
    invitationId: string,
    operatorId: string,
  ): Promise<FirstOperatorBootstrapState>;
  acceptInvitation(record: OperatorInvitationRecord): void;
  createOperator(record: OperatorRecord): void;
  createModeratorAuthority(record: ModeratorAuthorityRecord): void;
  createBootstrapRecord(record: FirstOperatorBootstrapRecord): void;
  createAuditRecord(record: BootstrapAuditRecord): void;
}

export interface FirstOperatorBootstrapStore {
  transact<Result>(
    work: (transaction: FirstOperatorBootstrapTransaction) => Promise<Result>,
  ): Promise<Result>;
}

export interface BootstrapFirstOperatorInput {
  readonly invitationId: string;
  readonly invitationSecret: string;
  readonly operatorId: string;
  readonly correlationId: string;
}

export interface BootstrapFirstOperatorDependencies {
  readonly store: FirstOperatorBootstrapStore;
  readonly digestSecret: (secret: string) => string;
  readonly digestsMatch: (left: string, right: string) => boolean;
  readonly now: () => Date;
}

export interface BootstrapFirstOperatorResult {
  readonly changed: boolean;
  readonly operatorId: string;
  readonly invitationId: string;
  readonly moderatorAuthorityGranted: true;
  readonly completedAt: Date;
}

export class BootstrapInvitationRejectedError extends Error {
  readonly code = "bootstrap_invitation_rejected";

  constructor() {
    super("The operator invitation cannot be accepted.");
    this.name = "BootstrapInvitationRejectedError";
  }
}

export class FirstModeratorAlreadyGrantedError extends Error {
  readonly code = "first_moderator_already_granted";

  constructor() {
    super("The first moderator authority was already granted.");
    this.name = "FirstModeratorAlreadyGrantedError";
  }
}

export async function bootstrapFirstOperator(
  dependencies: BootstrapFirstOperatorDependencies,
  input: BootstrapFirstOperatorInput,
): Promise<BootstrapFirstOperatorResult> {
  assertIdentifier(input.invitationId);
  assertIdentifier(input.operatorId);
  assertIdentifier(input.correlationId);
  if (!input.invitationSecret) throw new BootstrapInvitationRejectedError();
  const at = dependencies.now();
  const suppliedDigest = dependencies.digestSecret(input.invitationSecret);

  return dependencies.store.transact(async (transaction) => {
    const state = await transaction.readState(
      input.invitationId,
      input.operatorId,
    );
    if (
      state.bootstrap &&
      (state.bootstrap.invitationId !== input.invitationId ||
        state.bootstrap.operatorId !== input.operatorId)
    ) {
      throw new FirstModeratorAlreadyGrantedError();
    }
    const invitation = state.invitation;
    if (
      !invitation ||
      !suppliedDigest ||
      !dependencies.digestsMatch(invitation.secretDigest, suppliedDigest) ||
      invitation.revokedAt !== null ||
      invitation.recipientProofAt === null
    ) {
      throw new BootstrapInvitationRejectedError();
    }

    if (state.bootstrap) {
      if (
        invitation.acceptedOperatorId !== input.operatorId ||
        !state.operator ||
        !state.moderatorAuthority
      ) {
        throw new FirstModeratorAlreadyGrantedError();
      }
      return result(false, state.bootstrap);
    }

    if (invitation.expiresAt.getTime() <= at.getTime()) {
      throw new BootstrapInvitationRejectedError();
    }

    if (
      invitation.acceptedAt !== null ||
      invitation.acceptedOperatorId !== null ||
      state.operator ||
      state.moderatorAuthority ||
      state.anyModeratorAuthority
    ) {
      throw new FirstModeratorAlreadyGrantedError();
    }

    const acceptedInvitation = Object.freeze({
      ...invitation,
      acceptedAt: at,
      acceptedOperatorId: input.operatorId,
    });
    const operator = Object.freeze({
      id: input.operatorId,
      normalizedIdentity: invitation.intendedIdentity,
      sourceInvitationId: invitation.id,
      createdAt: at,
    });
    const moderatorAuthority = Object.freeze({
      operatorId: input.operatorId,
      grantedAt: at,
      source: "first_operator_bootstrap" as const,
    });
    const bootstrap = Object.freeze({
      invitationId: input.invitationId,
      operatorId: input.operatorId,
      completedAt: at,
    });
    const expireAt = new Date(at);
    expireAt.setUTCFullYear(expireAt.getUTCFullYear() + 1);

    transaction.acceptInvitation(acceptedInvitation);
    transaction.createOperator(operator);
    transaction.createModeratorAuthority(moderatorAuthority);
    transaction.createBootstrapRecord(bootstrap);
    for (const action of [
      "operator.enrolled",
      "moderator.authority_granted",
    ] as const) {
      transaction.createAuditRecord(
        Object.freeze({
          id: `${input.invitationId}-${action.replaceAll(".", "-")}`,
          actorType: "system",
          actorId: "deployment-bootstrap",
          action,
          subjectType: "operator",
          subjectId: input.operatorId,
          result: "completed",
          correlationId: input.correlationId,
          createdAt: at,
          expireAt,
        }),
      );
    }
    return result(true, bootstrap);
  });
}

export interface BootstrapEnrolledOperatorInput {
  readonly invitationId: string;
  readonly operatorId: string;
  readonly sessionToken: string;
  readonly origin: string;
  readonly correlationId: string;
}

export async function bootstrapEnrolledOperator(
  dependencies: BootstrapFirstOperatorDependencies,
  input: BootstrapEnrolledOperatorInput,
): Promise<BootstrapFirstOperatorResult> {
  assertIdentifier(input.invitationId);
  assertIdentifier(input.operatorId);
  assertIdentifier(input.correlationId);
  const separator = input.sessionToken.indexOf(".");
  if (separator < 1 || separator === input.sessionToken.length - 1)
    throw new BootstrapInvitationRejectedError();
  const sessionId = input.sessionToken.slice(0, separator);
  assertIdentifier(sessionId);
  const suppliedDigest = dependencies.digestSecret(
    input.sessionToken.slice(separator + 1),
  );
  const at = dependencies.now();
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    throw new BootstrapInvitationRejectedError();
  }
  if (
    origin.origin !== input.origin ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    )
  )
    throw new BootstrapInvitationRejectedError();
  return dependencies.store.transact(async (transaction) => {
    const state = await transaction.readState(
      input.invitationId,
      input.operatorId,
    );
    const session = await transaction.readSession?.(sessionId);
    const invitation = state.invitation;
    const operator = state.operator;
    if (
      !session ||
      !suppliedDigest ||
      !dependencies.digestsMatch(session.secretDigest, suppliedDigest) ||
      session.operatorId !== input.operatorId ||
      session.origin !== input.origin ||
      session.revokedAt !== null ||
      !Number.isFinite(session.expiresAt.getTime()) ||
      session.expiresAt <= at ||
      !Number.isFinite(session.authenticatedAt.getTime()) ||
      session.authenticatedAt > at ||
      at.getTime() - session.authenticatedAt.getTime() > 600_000 ||
      !invitation ||
      invitation.id !== input.invitationId ||
      invitation.revokedAt !== null ||
      !invitation.recipientProofAt ||
      !invitation.acceptedAt ||
      !Number.isFinite(invitation.recipientProofAt.getTime()) ||
      !Number.isFinite(invitation.acceptedAt.getTime()) ||
      !Number.isFinite(invitation.expiresAt.getTime()) ||
      invitation.recipientProofAt > invitation.acceptedAt ||
      invitation.acceptedAt > invitation.expiresAt ||
      invitation.acceptedAt > at ||
      invitation.acceptedOperatorId !== input.operatorId ||
      !operator ||
      operator.id !== input.operatorId ||
      operator.active === false ||
      operator.revokedAt ||
      operator.disabledAt ||
      operator.sourceInvitationId !== invitation.id ||
      operator.normalizedIdentity !== invitation.intendedIdentity
    )
      throw new BootstrapInvitationRejectedError();
    if (state.bootstrap) {
      if (
        state.bootstrap.invitationId !== input.invitationId ||
        state.bootstrap.operatorId !== input.operatorId ||
        state.moderatorAuthority?.operatorId !== input.operatorId ||
        (state.anyModeratorAuthority &&
          state.anyModeratorAuthority.operatorId !== input.operatorId)
      )
        throw new FirstModeratorAlreadyGrantedError();
      return result(false, state.bootstrap);
    }
    if (state.moderatorAuthority || state.anyModeratorAuthority)
      throw new FirstModeratorAlreadyGrantedError();
    const bootstrap = {
      invitationId: input.invitationId,
      operatorId: input.operatorId,
      completedAt: at,
    };
    transaction.createModeratorAuthority({
      operatorId: input.operatorId,
      grantedAt: at,
      source: "first_operator_bootstrap",
    });
    transaction.createBootstrapRecord(bootstrap);
    const expireAt = new Date(at);
    expireAt.setUTCFullYear(expireAt.getUTCFullYear() + 1);
    transaction.createAuditRecord({
      id: `${input.invitationId}-moderator-authority-granted`,
      actorType: "system",
      actorId: "deployment-bootstrap",
      action: "moderator.authority_granted",
      subjectType: "operator",
      subjectId: input.operatorId,
      result: "completed",
      correlationId: input.correlationId,
      createdAt: at,
      expireAt,
    });
    return result(true, bootstrap);
  });
}

function result(
  changed: boolean,
  bootstrap: FirstOperatorBootstrapRecord,
): BootstrapFirstOperatorResult {
  return Object.freeze({
    changed,
    operatorId: bootstrap.operatorId,
    invitationId: bootstrap.invitationId,
    moderatorAuthorityGranted: true,
    completedAt: bootstrap.completedAt,
  });
}

function assertIdentifier(value: string): void {
  if (!/^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/.test(value) || value.length > 128) {
    throw new TypeError("Bootstrap identifiers must use a bounded safe form.");
  }
}
