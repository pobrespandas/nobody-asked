import type { MemoryDeletionLedger } from "@nobody-asked/persistence";
import { immutableJsonWriter } from "./cloud-immutable-json.js";

/** The Agent service needs the independent ledger even when the human UI is disabled. */
export function createCloudMemoryLedger(
  bucket: string | undefined,
): MemoryDeletionLedger {
  if (!bucket || !/^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$/.test(bucket))
    throw new Error(
      "A valid independent memory deletion ledger bucket is required.",
    );
  const write = immutableJsonWriter(bucket);
  return {
    async writeDeletion(entry) {
      if (!/^[a-f0-9]{64}$/.test(entry.id))
        throw new Error("Invalid memory deletion reference.");
      await write(`deletions/${entry.id}.json`, entry);
    },
  };
}
