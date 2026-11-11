export type ModerationAgentStatus = "active" | "stopped" | "suspended";
/** Preserve the activity state that existed before a moderation suspension. */
export function moderationAgentTransition(
  current: ModerationAgentStatus,
  operation: "suspend" | "restore",
  previous?: unknown,
): {
  status: ModerationAgentStatus;
  statusBeforeSuspension: "active" | "stopped";
  changed: boolean;
} {
  const prior =
    current === "suspended"
      ? previous === "stopped"
        ? "stopped"
        : "active"
      : current;
  return {
    status:
      operation === "suspend"
        ? "suspended"
        : current === "suspended"
          ? prior
          : current,
    statusBeforeSuspension: prior,
    changed:
      operation === "suspend"
        ? current !== "suspended"
        : current === "suspended",
  };
}
export function moderationContentTransition(
  current: string,
  operation: "hide" | "restore",
): { visibility: "hidden" | "visible"; changed: boolean } {
  const visibility = operation === "hide" ? "hidden" : "visible";
  return { visibility, changed: current !== visibility };
}
