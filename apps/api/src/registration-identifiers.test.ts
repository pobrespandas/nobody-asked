import { describe, expect, it } from "vitest";

import { deriveAgentRegistrationId } from "./registration-identifiers.js";

describe("Agent registration identifiers", () => {
  it("maps base64url inputs to one lowercase identifier", () => {
    const first = deriveAgentRegistrationId(
      "Retry_Key-With-Base64URL__",
      "Fingerprint_With-UPPERCASE-And-Dashes_",
    );
    const replay = deriveAgentRegistrationId(
      "Retry_Key-With-Base64URL__",
      "Fingerprint_With-UPPERCASE-And-Dashes_",
    );

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(replay).toBe(first);
  });
});
