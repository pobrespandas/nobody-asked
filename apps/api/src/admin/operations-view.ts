import { dateTime, escapeHtml as e, label } from "./render.js";

function fields(data: Record<string, unknown>): string {
  return `<dl>${Object.entries(data)
    .map(([key, value]) => {
      const content =
        value == null
          ? "Unavailable"
          : Array.isArray(value)
            ? value
                .map((item) =>
                  item && typeof item === "object"
                    ? fields(item as Record<string, unknown>)
                    : e(item),
                )
                .join("")
            : typeof value === "object"
              ? fields(value as Record<string, unknown>)
              : typeof value === "boolean"
                ? value
                  ? "Yes"
                  : "No"
                : /At$|Time$/.test(key)
                  ? dateTime(value)
                  : e(value);
      return `<div><dt>${e(label(key))}</dt><dd>${content}</dd></div>`;
    })
    .join("")}</dl>`;
}
/** Render only captured, allowlisted observations. Never query Cloud APIs per visit. */
export function operationsObservation(
  value: unknown,
  now = new Date(),
): string {
  if (!value || typeof value !== "object")
    return "<p>No cloud observation is available. This does not mean that no backup exists.</p>";
  const observation = value as Record<string, unknown>;
  const verifiedAt =
    typeof observation.verifiedAt === "string" ? observation.verifiedAt : null;
  const age = verifiedAt ? now.getTime() - new Date(verifiedAt).getTime() : NaN;
  const freshness = !Number.isFinite(age)
    ? "Observation time unavailable"
    : age > 86400000
      ? "Observation is more than 24 hours old"
      : "Observed within the last 24 hours";
  let html = `<p>${e(freshness)}${verifiedAt ? ` · ${dateTime(verifiedAt)}` : ""}. This is a captured observation, not a live status check.</p>`;
  const cloud = observation.cloud as
    Record<string, Record<string, unknown>> | undefined;
  for (const section of ["runtime", "database", "queue"]) {
    const data = cloud?.[section];
    html += `<h3>${e(label(section))}</h3>${data ? fields(data) : "<p>Not collected.</p>"}`;
  }
  html += `<h3>Latest captured backup</h3>${observation.backup && typeof observation.backup === "object" ? fields(observation.backup as Record<string, unknown>) : "<p>No ready backup was captured for this database. Check the observation date and the backup console.</p>"}`;
  return html;
}
