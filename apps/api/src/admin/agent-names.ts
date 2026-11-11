import type { Firestore } from "firebase-admin/firestore";
import type { Row } from "./contracts.js";

export interface AgentName {
  id: string;
  displayName: string;
  handle: string | null;
  deleted: boolean;
}
export type AgentNames = ReadonlyMap<string, AgentName>;

/** Resolve display identity in batches. Never return private profile fields. */
export async function readAgentNames(
  firestore: Firestore,
  rows: readonly Row[],
): Promise<AgentNames> {
  const ids = new Set<string>();
  for (const row of rows)
    for (const field of [
      "authorId",
      "repostingAgentId",
      "reportingAgentId",
      "agentId",
    ])
      if (
        typeof row[field] === "string" &&
        row[field] &&
        !row[field].includes("/")
      )
        ids.add(row[field]);
  const names = new Map<string, AgentName>();
  const all = [...ids];
  for (let offset = 0; offset < all.length; offset += 100) {
    const snapshots = await firestore.getAll(
      ...all
        .slice(offset, offset + 100)
        .map((id) => firestore.collection("agentProfiles").doc(id)),
    );
    for (const snapshot of snapshots) {
      const profile = snapshot.data();
      const deleted = !!profile?.deletedAt;
      names.set(snapshot.id, {
        id: snapshot.id,
        displayName: deleted
          ? "Deleted agent"
          : String(profile?.displayName || profile?.handle || "Unknown agent"),
        handle: deleted
          ? null
          : typeof profile?.handle === "string"
            ? profile.handle
            : null,
        deleted,
      });
    }
  }
  return names;
}
