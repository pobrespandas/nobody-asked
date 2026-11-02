export const OPERATOR_CHALLENGE_LIFETIME_MS = 10 * 60 * 1_000;
export const OPERATOR_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;

export interface OperatorInvitation {
  readonly id: string;
  readonly intendedIdentity: string;
  readonly secretDigest: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface OperatorChallenge {
  readonly id: string;
  readonly normalizedIdentity: string;
  readonly secretDigest: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface OperatorSessionRecord {
  readonly id: string;
  readonly operatorId: string;
  readonly secretDigest: string;
  readonly origin: string;
  readonly authenticatedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export class OperatorEnrollmentRejectedError extends Error {
  readonly code = "operator_enrollment_rejected";
}

export class OperatorAuthenticationRejectedError extends Error {
  readonly code = "operator_authentication_rejected";
}

export class UnsafeOperatorSecretDigestError extends Error {
  readonly code = "unsafe_operator_secret_digest";
}

export function assertInvitationEnrollment(input: {
  readonly invitation: OperatorInvitation | null;
  readonly challenge: OperatorChallenge | null;
  readonly invitationDigest: string;
  readonly challengeDigest: string;
  readonly at: Date;
  readonly digestsMatch: (left: string, right: string) => boolean;
}): void {
  const { invitation, challenge, at } = input;
  if (
    !invitation ||
    !challenge ||
    invitation.acceptedAt !== null ||
    invitation.revokedAt !== null ||
    invitation.expiresAt.getTime() <= at.getTime() ||
    challenge.consumedAt !== null ||
    challenge.expiresAt.getTime() <= at.getTime() ||
    challenge.normalizedIdentity !== invitation.intendedIdentity ||
    !input.invitationDigest ||
    !input.challengeDigest ||
    !input.digestsMatch(invitation.secretDigest, input.invitationDigest) ||
    !input.digestsMatch(challenge.secretDigest, input.challengeDigest)
  ) {
    throw new OperatorEnrollmentRejectedError();
  }
}

export function assertOperatorAuthentication(input: {
  readonly operatorIdentity: string | null;
  readonly challenge: OperatorChallenge | null;
  readonly challengeDigest: string;
  readonly at: Date;
  readonly digestsMatch: (left: string, right: string) => boolean;
}): void {
  const { challenge, at } = input;
  if (
    !input.operatorIdentity ||
    !challenge ||
    challenge.normalizedIdentity !== input.operatorIdentity ||
    challenge.consumedAt !== null ||
    challenge.expiresAt.getTime() <= at.getTime() ||
    !input.challengeDigest ||
    !input.digestsMatch(challenge.secretDigest, input.challengeDigest)
  ) {
    throw new OperatorAuthenticationRejectedError();
  }
}

export function createOperatorSession(input: {
  readonly id: string;
  readonly operatorId: string;
  readonly rawSecret: string;
  readonly secretDigest: string;
  readonly origin: string;
  readonly authenticatedAt: Date;
}): OperatorSessionRecord {
  if (
    !input.rawSecret ||
    !input.secretDigest ||
    input.rawSecret === input.secretDigest
  ) {
    throw new UnsafeOperatorSecretDigestError();
  }
  return Object.freeze({
    id: input.id,
    operatorId: input.operatorId,
    secretDigest: input.secretDigest,
    origin: input.origin,
    authenticatedAt: input.authenticatedAt,
    expiresAt: new Date(
      input.authenticatedAt.getTime() + OPERATOR_SESSION_LIFETIME_MS,
    ),
    revokedAt: null,
  });
}
