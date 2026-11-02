import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

describe("deployment and incident runbook", () => {
  let runbook: string;

  beforeAll(async () => {
    runbook = await readFile(
      "docs/operations/deployment-incident-runbook.md",
      "utf8",
    );
  });

  it("fixes every hosted resource identifier", () => {
    for (const value of [
      "gen-lang-client-0607406471",
      "nobody-asked-dev",
      "nobody-asked-api",
      "us-central1",
      "nobodyasked-pobrespandas-prod",
      "nobodyasked-production",
    ]) {
      expect(runbook).toContain(value);
    }
  });

  it("covers every incident branch with verification and a safe stop", () => {
    const headings = [
      "## Deploy",
      "## Rollback API",
      "## Rollback browser",
      "## Traffic stop",
      "## Credential revocation",
      "## Data recovery",
      "## Incident evidence",
    ];
    for (const [index, heading] of headings.entries()) {
      const start = runbook.indexOf(heading);
      const end =
        index === headings.length - 1
          ? runbook.length
          : runbook.indexOf(headings[index + 1]!, start + heading.length);
      const section = runbook.slice(start, end);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(section).toMatch(/Verify|verification/);
      expect(section).toMatch(/Safe stop|safe stop/);
    }
  });

  it("keeps rollback, traffic stop, and recovery on explicit resources", () => {
    expect(runbook).toContain("--to-revisions=KNOWN_GOOD_REVISION=100");
    expect(runbook).toContain("--member=allUsers");
    expect(runbook).toContain("--role=roles/run.invoker");
    expect(runbook).toContain("nobody-asked-recovery-YYYYMMDD");
    expect(runbook).not.toMatch(/gcloud config set|firebase use/);
  });

  it("does not advise a direct Credential data edit", () => {
    const section = runbook.slice(
      runbook.indexOf("## Credential revocation"),
      runbook.indexOf("## Data recovery"),
    );
    expect(section).toContain(
      "DELETE /v1/operator/agents/{agentId}/credentials/{credentialId}",
    );
    expect(section).toContain(
      "Do not edit `credentials`, `agentAccess`, or `auditRecords` by hand",
    );
    expect(section).toContain("credential.revoked");
  });

  it("excludes sensitive values from incident evidence", () => {
    expect(runbook).toContain("Record no Credential value");
    expect(runbook).toContain("private moderation note");
    expect(runbook).toContain("post body");
    expect(runbook).toContain("raw environment value");
  });
});
