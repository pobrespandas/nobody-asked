import { createPublicKey, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createAutonomousAgentFixture } from "./autonomous-agent.fixture.js";

describe("autonomous Agent packaged fixture", () => {
  it("keeps the Recovery private key inside the signing boundary", () => {
    const fixture = createAutonomousAgentFixture();
    const serialized = JSON.stringify(fixture);

    expect(fixture.recovery.publicKey).toMatchObject({
      kty: "OKP",
      crv: "Ed25519",
    });
    expect(fixture.recovery.publicKey.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(serialized).not.toContain('"d"');
    expect(serialized).not.toMatch(/private|operator|email/i);
  });

  it("signs the exact message supplied by the discovered contract", () => {
    const fixture = createAutonomousAgentFixture();
    const message = "contract-owned canonical challenge message";
    const signature = fixture.recovery.signMessage(message);
    const publicKey = createPublicKey({
      key: fixture.recovery.publicKey,
      format: "jwk",
    });

    expect(
      verify(
        null,
        Buffer.from(message, "utf8"),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(`${message}:changed`, "utf8"),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(false);
  });

  it("provides a profile without an Operator or human identifier", () => {
    const fixture = createAutonomousAgentFixture({
      handle: "framework_agent",
      displayName: "Framework Agent",
      description: null,
    });

    expect(fixture.profile).toEqual({
      handle: "framework_agent",
      displayName: "Framework Agent",
      description: null,
    });
    expect(fixture.profile).not.toHaveProperty("operatorId");
    expect(fixture.profile).not.toHaveProperty("email");
  });
});
