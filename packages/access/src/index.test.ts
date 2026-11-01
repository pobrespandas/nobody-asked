import { describe, expect, it, vi } from "vitest";

import {
  ActiveCredentialExistsError,
  ActiveCredentialNotFoundError,
  AgentAccessBlockedError,
  type AgentId,
  type Credential,
  type CredentialDependencies,
  type CredentialId,
  CredentialNotFoundError,
  issueCredential,
  MultipleActiveCredentialsError,
  revokeCredential,
  rotateCredential,
  UnsafeCredentialDigestError,
} from "./index.js";

const agentId = "agent-1" as AgentId;
const issuedAt = new Date("2026-11-01T02:00:00.000Z");
const rotatedAt = new Date("2026-11-02T02:00:00.000Z");

function dependencies(
  overrides: Partial<CredentialDependencies> = {},
): CredentialDependencies {
  return {
    nextCredentialId: () => "credential-1" as CredentialId,
    generateSecret: () => "raw-secret-1",
    digestSecret: (secret) => `digest:${secret}`,
    now: () => issuedAt,
    ...overrides,
  };
}

function credential(overrides: Partial<Credential> = {}): Credential {
  return Object.freeze({
    id: "credential-1" as CredentialId,
    agentId,
    secretDigest: "digest:raw-secret-1",
    createdAt: issuedAt,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  });
}

describe("credential issuance", () => {
  it("returns the secret once and stores only its digest", () => {
    const result = issueCredential(dependencies(), {
      agent: { id: agentId, status: "active" },
      credentials: [],
    });

    expect(result.secret).toBe("raw-secret-1");
    expect(result.credential).toMatchObject({
      id: "credential-1",
      agentId,
      secretDigest: "digest:raw-secret-1",
      createdAt: issuedAt,
      revokedAt: null,
    });
    expect(result.credential).not.toHaveProperty("secret");
    expect(result.credentials).toEqual([result.credential]);
  });

  it("rejects a second active credential before it creates a secret", () => {
    const generateSecret = vi.fn(() => "raw-secret-2");

    expect(() =>
      issueCredential(dependencies({ generateSecret }), {
        agent: { id: agentId, status: "active" },
        credentials: [credential()],
      }),
    ).toThrow(ActiveCredentialExistsError);
    expect(generateSecret).not.toHaveBeenCalled();
  });

  it("rejects a digest that exposes the raw secret", () => {
    expect(() =>
      issueCredential(dependencies({ digestSecret: (secret) => secret }), {
        agent: { id: agentId, status: "active" },
        credentials: [],
      }),
    ).toThrow(UnsafeCredentialDigestError);
  });

  it.each(["stopped", "suspended"] as const)(
    "rejects issuance for a %s agent",
    (status) => {
      const nextCredentialId = vi.fn(() => "credential-1" as CredentialId);

      expect(() =>
        issueCredential(dependencies({ nextCredentialId }), {
          agent: { id: agentId, status },
          credentials: [],
        }),
      ).toThrow(AgentAccessBlockedError);
      expect(nextCredentialId).not.toHaveBeenCalled();
    },
  );
});

describe("credential rotation", () => {
  it("revokes the old credential and returns one new secret", () => {
    const oldCredential = credential();
    const result = rotateCredential(
      dependencies({
        nextCredentialId: () => "credential-2" as CredentialId,
        generateSecret: () => "raw-secret-2",
        now: () => rotatedAt,
      }),
      {
        agent: { id: agentId, status: "active" },
        credentials: [oldCredential],
      },
    );

    expect(result.secret).toBe("raw-secret-2");
    expect(result.credential).toMatchObject({
      id: "credential-2",
      secretDigest: "digest:raw-secret-2",
      revokedAt: null,
    });
    expect(result.credentials).toHaveLength(2);
    expect(result.credentials[0]).toMatchObject({
      id: "credential-1",
      revokedAt: rotatedAt,
    });
    expect(
      result.credentials.filter((item) => item.revokedAt === null),
    ).toEqual([result.credential]);
  });

  it("rejects rotation when corrupt state has two active credentials", () => {
    expect(() =>
      rotateCredential(dependencies(), {
        agent: { id: agentId, status: "active" },
        credentials: [
          credential(),
          credential({ id: "credential-2" as CredentialId }),
        ],
      }),
    ).toThrow(MultipleActiveCredentialsError);
  });

  it("rejects rotation when the agent has no active credential", () => {
    expect(() =>
      rotateCredential(dependencies(), {
        agent: { id: agentId, status: "active" },
        credentials: [credential({ revokedAt: issuedAt })],
      }),
    ).toThrow(ActiveCredentialNotFoundError);
  });

  it.each(["stopped", "suspended"] as const)(
    "rejects rotation for a %s agent without changing the old credential",
    (status) => {
      const oldCredential = credential();

      expect(() =>
        rotateCredential(dependencies({ now: () => rotatedAt }), {
          agent: { id: agentId, status },
          credentials: [oldCredential],
        }),
      ).toThrow(AgentAccessBlockedError);
      expect(oldCredential.revokedAt).toBeNull();
    },
  );
});

describe("credential revocation", () => {
  it("revokes a credential even after the agent is stopped", () => {
    const result = revokeCredential(
      { now: () => rotatedAt },
      {
        agentId,
        credentialId: "credential-1" as CredentialId,
        credentials: [credential()],
      },
    );

    expect(result.changed).toBe(true);
    expect(result.credential.revokedAt).toBe(rotatedAt);
    expect(result.credential).not.toHaveProperty("secret");
  });

  it("is idempotent after the first revocation", () => {
    const revokedAt = new Date("2026-11-01T03:00:00.000Z");
    const now = vi.fn(() => rotatedAt);
    const existingCredential = credential({ revokedAt });
    const result = revokeCredential(
      { now },
      {
        agentId,
        credentialId: existingCredential.id,
        credentials: [existingCredential],
      },
    );

    expect(result).toMatchObject({
      changed: false,
      credential: existingCredential,
    });
    expect(now).not.toHaveBeenCalled();
  });

  it("does not revoke a credential owned by another agent", () => {
    expect(() =>
      revokeCredential(
        { now: () => rotatedAt },
        {
          agentId: "agent-2" as AgentId,
          credentialId: "credential-1" as CredentialId,
          credentials: [credential()],
        },
      ),
    ).toThrow(CredentialNotFoundError);
  });
});
