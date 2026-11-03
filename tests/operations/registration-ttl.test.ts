import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertRegistrationTtlActive,
  registrationTtlPlan,
} from "../../tools/registration-ttl.js";

describe("registration TTL preparation", () => {
  it("declares the expiration field without indexing and prints a read-only inspection", () => {
    const config = JSON.parse(readFileSync("firestore.indexes.json", "utf8"));
    expect(config.fieldOverrides).toContainEqual({
      collectionGroup: "registrationControls",
      fieldPath: "expireAt",
      ttl: true,
      indexes: [],
    });
    expect(registrationTtlPlan().inspect).toContain("list");
    expect(registrationTtlPlan().globalDocumentMustHaveNoExpireAt).toBe(true);
  });
  it("accepts only ACTIVE TTL on the exact approved field", () => {
    const name =
      "projects/gen-lang-client-0607406471/databases/nobody-asked-dev/collectionGroups/registrationControls/fields/expireAt";
    expect(() =>
      assertRegistrationTtlActive([{ name, ttlConfig: { state: "ACTIVE" } }]),
    ).not.toThrow();
    for (const input of [
      [],
      {},
      [{ name, ttlConfig: { state: "CREATING" } }],
      [
        {
          name: name.replace("nobody-asked-dev", "other"),
          ttlConfig: { state: "ACTIVE" },
        },
      ],
    ])
      expect(() => assertRegistrationTtlActive(input)).toThrow();
  });
});
