import { describe, expect, it, vi } from "vitest";

import { createFirestoreReadiness } from "./composition.js";

describe("Firestore readiness", () => {
  it("reads only the dedicated operational document", async () => {
    const get = vi.fn(async () => ({ exists: false }));
    const doc = vi.fn(() => ({ get }));
    const collection = vi.fn(() => ({ doc }));

    await createFirestoreReadiness({ collection } as never).check();

    expect(collection).toHaveBeenCalledOnce();
    expect(collection).toHaveBeenCalledWith("_operations");
    expect(doc).toHaveBeenCalledOnce();
    expect(doc).toHaveBeenCalledWith("readiness");
    expect(get).toHaveBeenCalledOnce();
  });
});
