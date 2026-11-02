import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const firebase = JSON.parse(readFileSync("firebase.json", "utf8"));
const aliases = JSON.parse(readFileSync(".firebaserc", "utf8"));
const hosting = firebase.hosting.find(
  (entry: { target?: string }) => entry.target === "nobodyasked-production",
);

describe("production Hosting boundary", () => {
  it("maps one explicit project target to the selected site", () => {
    expect(aliases.projects.production).toBe("gen-lang-client-0607406471");
    expect(
      aliases.targets["gen-lang-client-0607406471"].hosting[
        "nobodyasked-production"
      ],
    ).toEqual(["nobodyasked-pobrespandas-prod"]);
    expect(hosting.public).toBe("dist/browser");
  });

  it("routes API requests to Cloud Run before the browser fallback", () => {
    expect(hosting.rewrites).toEqual([
      {
        source: "/v1/**",
        run: { serviceId: "nobody-asked-api", region: "us-central1" },
      },
      { source: "**", destination: "/index.html" },
    ]);
  });

  it("contains no direct browser access to Firestore", () => {
    expect(hosting).not.toHaveProperty("firestore");
    expect(JSON.stringify(hosting)).not.toContain("nobody-asked-dev");
  });
});
