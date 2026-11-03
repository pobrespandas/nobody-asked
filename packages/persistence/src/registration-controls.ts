import { DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY } from "@nobody-asked/access";
import { Timestamp, type DocumentData } from "firebase-admin/firestore";

export function registrationControl(data: DocumentData | undefined, at: Date) {
  const policy = DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY;
  const start = data?.windowStartedAt ? asDate(data.windowStartedAt) : at;
  const current = at.getTime() < start.getTime() + policy.windowMs;
  const pending = (
    (data?.pending ?? []) as Array<{ id: string; expiresAt: Timestamp }>
  ).filter((entry) => asDate(entry.expiresAt) > at);
  return {
    bucket: {
      count: current ? Number(data?.count ?? 0) : 0,
      windowStartedAt: current ? start : at,
    },
    pending,
  };
}

export function reserveRegistrationLease(
  control: ReturnType<typeof registrationControl>,
  registrationId: string,
  challengeExpiresAt: Date,
  source: boolean,
) {
  return {
    count: control.bucket.count + 1,
    windowStartedAt: Timestamp.fromDate(control.bucket.windowStartedAt),
    pending: [
      ...control.pending,
      { id: registrationId, expiresAt: Timestamp.fromDate(challengeExpiresAt) },
    ],
    ...(source
      ? {
          expireAt: Timestamp.fromDate(
            new Date(
              Math.max(
                control.bucket.windowStartedAt.getTime() +
                  DEFAULT_AGENT_REGISTRATION_LIMIT_POLICY.windowMs,
                challengeExpiresAt.getTime(),
              ),
            ),
          ),
        }
      : {}),
  };
}

function asDate(value: unknown): Date {
  return value instanceof Timestamp ? value.toDate() : (value as Date);
}
