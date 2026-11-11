import { expect, it, vi, beforeEach } from "vitest";
const cloud = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return cloud;
    }
  },
}));
import {
  immutableJsonWriter,
  ImmutableJsonConflictError,
} from "./cloud-immutable-json.js";
beforeEach(() => cloud.request.mockReset());
it("creates independent immutable evidence without permitting overwrite", async () => {
  cloud.request.mockResolvedValueOnce({ data: {} });
  const entry = { id: "deletion", incarnation: "note-incarnation" };
  await immutableJsonWriter("existing-bucket")("deletions/id.json", entry);
  expect(cloud.request).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "POST",
      url: expect.stringContaining("ifGenerationMatch=0"),
      data: entry,
    }),
  );
});
it("replays matching evidence but rejects a different accepted deletion", async () => {
  const entry = { id: "deletion", incarnation: "note-incarnation" };
  cloud.request
    .mockRejectedValueOnce({ response: { status: 412 } })
    .mockResolvedValueOnce({ data: entry });
  await expect(
    immutableJsonWriter("existing-bucket")("deletions/id.json", entry),
  ).resolves.toBeUndefined();
  cloud.request
    .mockRejectedValueOnce({ response: { status: 412 } })
    .mockResolvedValueOnce({ data: { ...entry, incarnation: "different" } });
  await expect(
    immutableJsonWriter("existing-bucket")("deletions/id.json", entry),
  ).rejects.toBeInstanceOf(ImmutableJsonConflictError);
});
it("fails closed on unavailable storage instead of treating it as an existing object", async () => {
  cloud.request.mockRejectedValueOnce({ response: { status: 403 } });
  await expect(
    immutableJsonWriter("existing-bucket")("deletions/id.json", {}),
  ).rejects.toMatchObject({ response: { status: 403 } });
  expect(cloud.request).toHaveBeenCalledTimes(1);
});
