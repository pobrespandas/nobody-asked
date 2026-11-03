import { describe, expect, it, vi } from "vitest";

import {
  createJsonOperationalLogger,
  observeRequest,
  readObservabilityConfig,
} from "./index.js";

describe("operational observability", () => {
  it("serializes a fixed delivery failure event without request data", () => {
    const lines: string[] = [];
    const logger = createJsonOperationalLogger(
      (line) => lines.push(line),
      () => new Date("2026-11-02T00:00:00Z"),
    );
    logger.write({
      severity: "ERROR",
      event: "operator.challenge.delivery_failed",
    });
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: "2026-11-02T00:00:00.000Z",
      severity: "ERROR",
      event: "operator.challenge.delivery_failed",
    });
    expect(lines[0]).not.toMatch(
      /identity|challengeSecret|recipient|provider|authorization/,
    );
  });
  it("writes one allowlisted JSON record", async () => {
    const lines: string[] = [];
    const logger = createJsonOperationalLogger(
      (line) => lines.push(line),
      () => new Date("2026-11-02T00:00:00.000Z"),
    );
    const times = [10, 22];
    const response = await observeRequest(
      logger,
      () => times.shift()!,
      { method: "POST", route: "post.publish" },
      async () => Response.json({ data: { text: "private post body" } }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(lines[0]!)).toEqual({
      timestamp: "2026-11-02T00:00:00.000Z",
      severity: "INFO",
      event: "http.request.completed",
      method: "POST",
      route: "post.publish",
      status: 200,
      durationMs: 12,
    });
    expect(lines[0]).not.toMatch(/private post body/i);
  });

  it("classifies rejected and failed requests without error details", async () => {
    const write = vi.fn();
    const logger = { write };
    const clock = () => 1;

    await observeRequest(
      logger,
      clock,
      { method: "GET", route: "health.ready" },
      async () => new Response(null, { status: 503 }),
    );
    await observeRequest(
      logger,
      clock,
      { method: "GET", route: "unmatched" },
      async () => new Response(null, { status: 404 }),
    );

    expect(write.mock.calls[0]?.[0]).toMatchObject({ severity: "ERROR" });
    expect(write.mock.calls[1]?.[0]).toMatchObject({ severity: "WARNING" });
  });

  it("does not change a response when the log sink fails", async () => {
    const response = await observeRequest(
      {
        write() {
          throw new Error("log sink unavailable");
        },
      },
      () => 1,
      { method: "GET", route: "timeline.read" },
      async () => new Response(null, { status: 204 }),
    );

    expect(response.status).toBe(204);
  });

  it("loads bounded local alert thresholds", () => {
    expect(readObservabilityConfig({})).toEqual({
      availability: {
        targets: [
          { service: "api", path: "/health/ready" },
          { service: "browser", path: "/" },
        ],
        intervalSeconds: 60,
        consecutiveFailures: 3,
      },
      errors: {
        windowSeconds: 300,
        minimumRequests: 20,
        rateThreshold: 0.05,
      },
      latency: { windowSeconds: 300, percentile: 95, thresholdMs: 1_000 },
    });
    expect(
      readObservabilityConfig({
        OBSERVABILITY_AVAILABILITY_INTERVAL_SECONDS: "30",
        OBSERVABILITY_AVAILABILITY_FAILURES: "2",
        OBSERVABILITY_ERROR_WINDOW_SECONDS: "600",
        OBSERVABILITY_ERROR_MINIMUM_REQUESTS: "50",
        OBSERVABILITY_ERROR_RATE_THRESHOLD: "0.1",
        OBSERVABILITY_LATENCY_WINDOW_SECONDS: "600",
        OBSERVABILITY_LATENCY_THRESHOLD_MS: "750",
      }),
    ).toMatchObject({
      availability: { intervalSeconds: 30, consecutiveFailures: 2 },
      errors: {
        windowSeconds: 600,
        minimumRequests: 50,
        rateThreshold: 0.1,
      },
      latency: { windowSeconds: 600, thresholdMs: 750 },
    });
  });

  it("rejects unsafe alert thresholds", () => {
    expect(() =>
      readObservabilityConfig({
        OBSERVABILITY_ERROR_RATE_THRESHOLD: "1",
      }),
    ).toThrow("between 0 and 1");
    expect(() =>
      readObservabilityConfig({
        OBSERVABILITY_LATENCY_THRESHOLD_MS: "credential-secret",
      }),
    ).toThrow("Invalid observability integer");
  });
});
