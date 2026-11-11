import { GoogleAuth } from "google-auth-library";

export class ImmutableJsonConflictError extends Error {
  readonly code = "immutable_object_conflict";
  constructor() {
    super("The immutable object has different bytes.");
  }
}

/** Share immutable storage mechanics without depending on human administration. */
export function immutableJsonWriter(bucketName: string) {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const bucket = encodeURIComponent(bucketName);
  return async (name: string, value: unknown): Promise<void> => {
    const client = await auth.getClient();
    try {
      await client.request({
        url: `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=0`,
        method: "POST",
        data: value,
      });
    } catch (error) {
      if (
        (error as { response?: { status?: number } }).response?.status !== 412
      )
        throw error;
      const existing = await client.request<unknown>({
        url: `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`,
        method: "GET",
      });
      if (JSON.stringify(existing.data) !== JSON.stringify(value))
        throw new ImmutableJsonConflictError();
    }
  };
}
