import { describe, expect, it } from "vitest";

import {
  assertInvitationEnrollment,
  assertOperatorAuthentication,
  createOperatorSession,
  OPERATOR_SESSION_LIFETIME_MS,
  OperatorEnrollmentRejectedError,
  OperatorAuthenticationRejectedError,
  UnsafeOperatorSecretDigestError,
} from "./operator-session.js";

const at = new Date("2026-11-02T12:00:00.000Z");

describe("operator enrollment", () => {
  it.each([
    { consumedAt: at },
    { expiresAt: at },
    { normalizedIdentity: "another@example.test" },
    { secretDigest: "digest:another-challenge" },
  ])("rejects unavailable or unrelated recipient proof", (override) => {
    expect(() =>
      assertInvitationEnrollment({
        invitation: invitation(),
        challenge: challenge(override),
        invitationDigest: "digest:invitation-secret",
        challengeDigest: "digest:challenge-secret",
        at,
        digestsMatch: (left, right) => left === right,
      }),
    ).toThrow(OperatorEnrollmentRejectedError);
  });
  it("accepts one live invitation with recipient proof", () => {
    expect(() =>
      assertInvitationEnrollment({
        invitation: invitation(),
        challenge: challenge(),
        invitationDigest: "digest:invitation-secret",
        challengeDigest: "digest:challenge-secret",
        at,
        digestsMatch: (left, right) => left === right,
      }),
    ).not.toThrow();
  });

  it.each([{ acceptedAt: at }, { revokedAt: at }, { expiresAt: at }])(
    "rejects an unavailable invitation",
    (override) => {
      expect(() =>
        assertInvitationEnrollment({
          invitation: invitation(override),
          challenge: challenge(),
          invitationDigest: "digest:invitation-secret",
          challengeDigest: "digest:challenge-secret",
          at,
          digestsMatch: (left, right) => left === right,
        }),
      ).toThrow(OperatorEnrollmentRejectedError);
    },
  );
});

describe("operator session", () => {
  it("expires after 12 hours and keeps only the digest", () => {
    const session = createOperatorSession({
      id: "session-1",
      operatorId: "operator-1",
      rawSecret: "session-secret",
      secretDigest: "digest:session-secret",
      origin: "https://operator.example",
      authenticatedAt: at,
    });

    expect(session.expiresAt.getTime() - at.getTime()).toBe(
      OPERATOR_SESSION_LIFETIME_MS,
    );
    expect(session).not.toHaveProperty("rawSecret");
  });

  it("rejects a raw secret as its digest", () => {
    expect(() =>
      createOperatorSession({
        id: "session-1",
        operatorId: "operator-1",
        rawSecret: "same",
        secretDigest: "same",
        origin: "https://operator.example",
        authenticatedAt: at,
      }),
    ).toThrow(UnsafeOperatorSecretDigestError);
  });
});

describe("operator recovery authentication", () => {
  const authentication = () => ({
    operatorIdentity: "operator@example.test",
    challenge: challenge(),
    challengeDigest: "digest:challenge-secret",
    at,
    digestsMatch: (left: string, right: string) => left === right,
  });

  it("accepts a live matching recovery proof", () => {
    expect(() => assertOperatorAuthentication(authentication())).not.toThrow();
  });

  it.each([
    { operatorIdentity: null },
    { operatorIdentity: "another@example.test" },
    { challenge: null },
    { challenge: challenge({ consumedAt: at }) },
    { challenge: challenge({ expiresAt: at }) },
    { challengeDigest: "digest:incorrect-secret" },
    { challengeDigest: "" },
  ])("rejects invalid, expired, or reused recovery proof", (override) => {
    expect(() =>
      assertOperatorAuthentication({ ...authentication(), ...override }),
    ).toThrow(OperatorAuthenticationRejectedError);
  });
});

function invitation(override: object = {}) {
  return {
    id: "invitation-1",
    intendedIdentity: "operator@example.test",
    secretDigest: "digest:invitation-secret",
    expiresAt: new Date(at.getTime() + 60_000),
    acceptedAt: null,
    revokedAt: null,
    ...override,
  };
}

function challenge(override: object = {}) {
  return {
    id: "challenge-1",
    normalizedIdentity: "operator@example.test",
    secretDigest: "digest:challenge-secret",
    expiresAt: new Date(at.getTime() + 60_000),
    consumedAt: null,
    ...override,
  };
}
