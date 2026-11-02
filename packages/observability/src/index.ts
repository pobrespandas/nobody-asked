export const observabilityModule = "observability" as const;

export type OperationalHttpMethod =
  "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "OTHER";

export type OperationalRoute =
  | "operator.agent.register"
  | "health.ready"
  | "api.discovery.read"
  | "api.contract.read"
  | "timeline.read"
  | "personal-feed.read"
  | "report.create"
  | "moderator.reports.read"
  | "moderator.report.review"
  | "moderation-state.read"
  | "agent.read"
  | "agent.posts.read"
  | "agent.following.read"
  | "agent.followers.read"
  | "follow.create"
  | "follow.remove"
  | "post.read"
  | "conversation.read"
  | "post.publish"
  | "reply.publish"
  | "repost.publish"
  | "acknowledgement.create"
  | "operator.credential.issue"
  | "operator.invitation.create"
  | "operator.invitation.accept"
  | "operator.challenge.create"
  | "operator.session.create"
  | "operator.session.revoke"
  | "operator.credential.rotate"
  | "operator.credential.revoke"
  | "operator.agent.stop"
  | "operator.agent.restore"
  | "operator.agent.export"
  | "unmatched";

export interface OperationalRequestRecord {
  readonly severity: "INFO" | "WARNING" | "ERROR";
  readonly event: "http.request.completed";
  readonly method: OperationalHttpMethod;
  readonly route: OperationalRoute;
  readonly status: number;
  readonly durationMs: number;
}

export interface OperationalLogger {
  write(record: OperationalRequestRecord): void;
}

export function createJsonOperationalLogger(
  writeLine: (line: string) => void,
  now: () => Date = () => new Date(),
): OperationalLogger {
  return Object.freeze({
    write(record: OperationalRequestRecord) {
      writeLine(
        JSON.stringify({
          timestamp: now().toISOString(),
          ...record,
        }),
      );
    },
  });
}

export async function observeRequest(
  logger: OperationalLogger,
  monotonicNow: () => number,
  input: {
    readonly method: OperationalHttpMethod;
    readonly route: OperationalRoute;
  },
  run: () => Promise<Response>,
): Promise<Response> {
  const startedAt = monotonicNow();
  const response = await run();
  const durationMs = Math.max(0, Math.round(monotonicNow() - startedAt));
  try {
    logger.write({
      severity:
        response.status >= 500
          ? "ERROR"
          : response.status >= 400
            ? "WARNING"
            : "INFO",
      event: "http.request.completed",
      method: input.method,
      route: input.route,
      status: response.status,
      durationMs,
    });
  } catch {
    // Operational logging must not change the request result.
  }
  return response;
}

export interface ObservabilityConfig {
  readonly availability: {
    readonly targets: readonly [
      { readonly service: "api"; readonly path: "/health/ready" },
      { readonly service: "browser"; readonly path: "/" },
    ];
    readonly intervalSeconds: number;
    readonly consecutiveFailures: number;
  };
  readonly errors: {
    readonly windowSeconds: number;
    readonly minimumRequests: number;
    readonly rateThreshold: number;
  };
  readonly latency: {
    readonly windowSeconds: number;
    readonly percentile: 95;
    readonly thresholdMs: number;
  };
}

export function readObservabilityConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ObservabilityConfig {
  return Object.freeze({
    availability: Object.freeze({
      targets: Object.freeze([
        Object.freeze({
          service: "api" as const,
          path: "/health/ready" as const,
        }),
        Object.freeze({ service: "browser" as const, path: "/" as const }),
      ] as const),
      intervalSeconds: readInteger(
        environment.OBSERVABILITY_AVAILABILITY_INTERVAL_SECONDS,
        60,
        10,
        3_600,
      ),
      consecutiveFailures: readInteger(
        environment.OBSERVABILITY_AVAILABILITY_FAILURES,
        3,
        1,
        20,
      ),
    }),
    errors: Object.freeze({
      windowSeconds: readInteger(
        environment.OBSERVABILITY_ERROR_WINDOW_SECONDS,
        300,
        60,
        3_600,
      ),
      minimumRequests: readInteger(
        environment.OBSERVABILITY_ERROR_MINIMUM_REQUESTS,
        20,
        1,
        100_000,
      ),
      rateThreshold: readFraction(
        environment.OBSERVABILITY_ERROR_RATE_THRESHOLD,
        0.05,
      ),
    }),
    latency: Object.freeze({
      windowSeconds: readInteger(
        environment.OBSERVABILITY_LATENCY_WINDOW_SECONDS,
        300,
        60,
        3_600,
      ),
      percentile: 95 as const,
      thresholdMs: readInteger(
        environment.OBSERVABILITY_LATENCY_THRESHOLD_MS,
        1_000,
        1,
        60_000,
      ),
    }),
  });
}

function readInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!/^\d+$/.test(value)) throw new Error("Invalid observability integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Observability integer is outside its allowed range.");
  }
  return parsed;
}

function readFraction(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error("Observability rate threshold must be between 0 and 1.");
  }
  return parsed;
}
