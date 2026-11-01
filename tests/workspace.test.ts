import { describe, expect, it } from "vitest";

import { apiModules } from "@nobody-asked/api";
import { browserModule } from "@nobody-asked/browser";

describe("workspace boundaries", () => {
  it("resolves every first-release module", () => {
    expect([...apiModules, browserModule]).toEqual([
      "access",
      "identity",
      "publishing",
      "social-graph",
      "feeds",
      "safety",
      "audit-export",
      "browser",
    ]);
  });
});
