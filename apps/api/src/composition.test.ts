import { describe, expect, it, vi } from "vitest";
import { createFirestoreReadiness } from "./composition.js";

describe("Firestore readiness", () => {
  it("reads only operational readiness and deletion recovery state", async () => {
    const get = vi.fn(async () => ({ exists: false }));
    const doc = vi.fn(() => ({ get }));
    const collection = vi.fn(() => ({ doc }));
    await createFirestoreReadiness({ collection } as never).check();
    expect(collection).toHaveBeenCalledTimes(2);
    expect(collection).toHaveBeenCalledWith("_operations");
    expect(doc.mock.calls).toEqual([["readiness"], ["deletionRecovery"]]);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("rejects an incomplete restored database", async () => {
    const firestore = {
      collection: () => ({
        doc: (name: string) => ({
          get: async () => ({
            exists: name === "deletionRecovery",
            data: () => ({ ready: false }),
          }),
        }),
      }),
    };
    await expect(
      createFirestoreReadiness(firestore as never).check(),
    ).rejects.toThrow("Deletion recovery is incomplete.");
  });
});
