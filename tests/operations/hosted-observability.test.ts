import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(path, "utf8"));

const resources = readJson("deploy/monitoring/resources.json") as {
  projectId: string;
  api: { service: string; region: string; host: string; uptimeCheck: string };
  browser: { host: string; uptimeCheck: string };
  alertPolicies: Record<string, string>;
  notificationChannels: Array<{
    name: string;
    type: string;
    displayName: string;
    address: string;
  }>;
};
const availability = readJson("deploy/monitoring/availability-policy.json");
const serverErrors = readJson("deploy/monitoring/error-rate-policy.json");
const latency = readJson("deploy/monitoring/latency-policy.json");

describe("hosted observability contract", () => {
  it("fixes every monitor to the production resources", () => {
    expect(resources).toMatchObject({
      projectId: "gen-lang-client-0607406471",
      api: {
        service: "nobody-asked-api",
        region: "us-central1",
        host: "nobody-asked-api-284051889944.us-central1.run.app",
      },
      browser: { host: "nobodyasked.pobrespandas.com" },
    });
    expect(Object.keys(resources.alertPolicies)).toEqual([
      "availability",
      "serverErrors",
      "latency",
    ]);
  });

  it("connects availability alerts to both recorded uptime checks", () => {
    const policy = JSON.stringify(availability);
    expect(policy).toContain(resources.api.uptimeCheck.split("/").at(-1));
    expect(policy).toContain(resources.browser.uptimeCheck.split("/").at(-1));
    expect(policy).toContain("ALIGN_FRACTION_TRUE");
    expect(policy).toContain('"duration":"180s"');
  });

  it("uses Cloud Run metrics for server errors and p95 latency", () => {
    const errorPolicy = JSON.stringify(serverErrors);
    const latencyPolicy = JSON.stringify(latency);

    expect(errorPolicy).toContain("run.googleapis.com/request_count");
    expect(errorPolicy).toContain('metric.label.response_code_class=\\"5xx\\"');
    expect(errorPolicy).toContain(
      'resource.label.service_name=\\"nobody-asked-api\\"',
    );
    expect(latencyPolicy).toContain("run.googleapis.com/request_latencies");
    expect(latencyPolicy).toContain("ALIGN_PERCENTILE_95");
    expect(latencyPolicy).toContain('"thresholdValue":1000');
  });

  it("routes every policy to the one approved email destination", () => {
    expect(resources.notificationChannels).toEqual([
      {
        name: "projects/gen-lang-client-0607406471/notificationChannels/1508763003618954322",
        type: "email",
        displayName: "Nobody Asked operations email",
        address: "andres.tobelem@gmail.com",
      },
    ]);
    const channel = resources.notificationChannels[0]!.name;
    for (const policy of [availability, serverErrors, latency]) {
      const text = JSON.stringify(policy).toLowerCase();
      expect(policy).toMatchObject({ notificationChannels: [channel] });
      expect(text).not.toMatch(
        /credential secret|authorization|request body|response body|private note/,
      );
    }
  });
});
