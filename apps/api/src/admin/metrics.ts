import {
  FieldValue,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import type { OperationalLogger } from "@nobody-asked/observability";
import { requireAdmin } from "./contracts.js";

/** Buffer operational event counts. Flushes do not scan network records. */
export function administrationLogger(
  firestore: Firestore,
  delegate: OperationalLogger,
  now = () => new Date(),
): OperationalLogger & { flush(): Promise<void> } {
  const buckets = new Map<string, Record<string, number>>();
  return {
    write(record) {
      delegate.write(record);
      const hour = now().toISOString().slice(0, 13);
      const counts = buckets.get(hour) ?? {};
      const increment = (key: string) => {
        counts[key] = (counts[key] ?? 0) + 1;
      };
      if (record.event === "http.request.completed") increment("requests");
      if (record.event === "operator.challenge.delivery_failed")
        increment("mailFailures");
      else {
        if (record.status >= 500) increment("failures");
        if (record.status === 429) increment("rateLimited");
      }
      buckets.set(hour, counts);
    },
    async flush() {
      const pending = [...buckets.entries()];
      buckets.clear();
      try {
        const batch = firestore.batch();
        for (const [hour, values] of pending) {
          const day = hour.slice(0, 10);
          const increments = Object.fromEntries(
            Object.entries(values).map(([key, count]) => [
              key,
              FieldValue.increment(count),
            ]),
          );
          batch.set(
            firestore.collection("adminHourlyMetrics").doc(hour),
            { ...increments, observedAt: Timestamp.fromDate(now()) },
            { merge: true },
          );
          batch.set(
            firestore.collection("adminDailyMetrics").doc(day),
            { ...increments, observedAt: Timestamp.fromDate(now()) },
            { merge: true },
          );
        }
        if (pending.length) await batch.commit();
      } catch {
        for (const [hour, values] of pending) {
          const counts = buckets.get(hour) ?? {};
          for (const [key, count] of Object.entries(values))
            counts[key] = (counts[key] ?? 0) + count;
          buckets.set(hour, counts);
        }
        console.error(
          '{"severity":"ERROR","event":"administration.metrics_flush_failed"}',
        );
      }
    },
  };
}
export async function readSummary(
  firestore: Firestore,
  days: number,
  now = new Date(),
) {
  requireAdmin([1, 7, 30].includes(days));
  const collection = days === 1 ? "adminHourlyMetrics" : "adminDailyMetrics";
  const start = new Date(now.getTime() - days * 86400000)
    .toISOString()
    .slice(0, days === 1 ? 13 : 10);
  const result = await firestore
    .collection(collection)
    .orderBy("__name__")
    .startAt(start)
    .limit(days === 1 ? 25 : 31)
    .get();
  const publications = await firestore
    .collection(days === 1 ? "networkHourlyMetrics" : "networkDailyMetrics")
    .orderBy("__name__")
    .startAt(start)
    .limit(days === 1 ? 25 : 31)
    .get();
  const counts: Record<string, number> = {};
  for (const snapshot of [...result.docs, ...publications.docs])
    for (const [key, value] of Object.entries(snapshot.data()))
      if (typeof value === "number") counts[key] = (counts[key] ?? 0) + value;
  const [agents, reports, jobs, observation] = await Promise.all([
    firestore
      .collection("agentProfiles")
      .where("status", "==", "active")
      .count()
      .get(),
    firestore
      .collection("reports")
      .where("resolvedAt", "==", null)
      .count()
      .get(),
    firestore
      .collection("adminJobs")
      .where("status", "in", [
        "pending",
        "running",
        "failed",
        "dispatch_failed",
      ])
      .count()
      .get(),
    firestore.collection("adminObservations").doc("runtime").get(),
  ]);
  return {
    days,
    observedAt: now.toISOString(),
    events: result.empty && publications.empty ? null : counts,
    coverage:
      result.empty && publications.empty
        ? "unavailable"
        : "collected_buckets_only",
    gauges: {
      activeAgents: agents.data().count,
      openReports: reports.data().count,
      pendingJobs: jobs.data().count,
    },
    technical: observation.exists ? observation.data() : null,
  };
}
