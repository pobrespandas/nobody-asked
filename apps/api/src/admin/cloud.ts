import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { AdminError, requireAdmin } from "./contracts.js";
import type { AdminConfig } from "./config.js";
import type { JobObjects, JobQueue, LedgerEntry } from "./jobs.js";

export function cloudJobs(config: AdminConfig): {
  objects: JobObjects | null;
  queue: JobQueue | null;
  verifyTask(request: Request): Promise<void>;
} {
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const verifier = new OAuth2Client();
  async function request<T>(
    url: string,
    method: "GET" | "POST" | "DELETE",
    data?: unknown,
  ): Promise<T> {
    const client = await auth.getClient();
    const response = await client.request<T>({
      url,
      method,
      ...(data === undefined ? {} : { data }),
    });
    return response.data;
  }
  const bucket = encodeURIComponent(config.ledgerBucket ?? "");
  const objectUrl = (name: string) =>
    `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}`;
  async function write(name: string, value: unknown) {
    try {
      await request(
        `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=0`,
        "POST",
        value,
      );
    } catch (error) {
      if (
        (error as { response?: { status?: number } }).response?.status !== 412
      )
        throw error;
      const existing = await request<unknown>(
        `${objectUrl(name)}?alt=media`,
        "GET",
      );
      requireAdmin(
        JSON.stringify(existing) === JSON.stringify(value),
        409,
        "immutable_object_conflict",
      );
    }
  }
  const objects: JobObjects | null = !config.ledgerBucket
    ? null
    : {
        writeLedger: (entry) => write(`deletions/${entry.id}.json`, entry),
        writeArtifact: (id, value) => write(id, value),
        readArtifact: (id) => request(`${objectUrl(id)}?alt=media`, "GET"),
        async deleteArtifacts(prefix) {
          requireAdmin(prefix.startsWith("exports/") && !prefix.includes(".."));
          const params = new URLSearchParams({ prefix, maxResults: "100" });
          const page = await request<{ items?: { name: string }[] }>(
            `https://storage.googleapis.com/storage/v1/b/${bucket}/o?${params}`,
            "GET",
          );
          for (const item of page.items ?? []) {
            try {
              await request(objectUrl(item.name), "DELETE");
            } catch (error) {
              if (
                (error as { response?: { status?: number } }).response
                  ?.status !== 404
              )
                throw error;
            }
          }
          return (page.items?.length ?? 0) < 100;
        },
        async listLedger(cursor) {
          const params = new URLSearchParams({
            prefix: "deletions/",
            maxResults: "100",
          });
          if (cursor) params.set("pageToken", cursor);
          const page = await request<{
            items?: { name: string }[];
            nextPageToken?: string;
          }>(
            `https://storage.googleapis.com/storage/v1/b/${bucket}/o?${params}`,
            "GET",
          );
          const items = await Promise.all(
            (page.items ?? []).map((item) =>
              request<LedgerEntry>(`${objectUrl(item.name)}?alt=media`, "GET"),
            ),
          );
          return { items, nextCursor: page.nextPageToken ?? null };
        },
      };
  const queue: JobQueue | null = !config.queue
    ? null
    : {
        async enqueue(id, attempt) {
          const name = `${config.queue}/tasks/admin-${id}-${attempt}`;
          try {
            await request(
              `https://cloudtasks.googleapis.com/v2/${config.queue}/tasks`,
              "POST",
              {
                task: {
                  name,
                  httpRequest: {
                    httpMethod: "POST",
                    url: config.taskUrl,
                    headers: { "Content-Type": "application/json" },
                    body: Buffer.from(JSON.stringify({ id })).toString(
                      "base64",
                    ),
                    oidcToken: {
                      serviceAccountEmail: config.taskServiceAccount,
                      audience: config.taskUrl,
                    },
                  },
                },
              },
            );
          } catch (error) {
            if (
              (error as { response?: { status?: number } }).response?.status !==
              409
            )
              throw error;
          }
        },
      };
  return {
    objects,
    queue,
    async verifyTask(incoming) {
      requireAdmin(
        config.taskUrl && config.taskServiceAccount,
        503,
        "durable_jobs_not_configured",
      );
      const authorization = incoming.headers.get("authorization");
      requireAdmin(
        authorization && authorization.startsWith("Bearer "),
        401,
        "task_authentication_required",
      );
      const ticket = await verifier
        .verifyIdToken({
          idToken: authorization.slice(7),
          audience: config.taskUrl,
        })
        .catch(() => {
          throw new AdminError(401, "task_authentication_required");
        });
      const payload = ticket.getPayload();
      requireAdmin(
        payload?.email_verified && payload.email === config.taskServiceAccount,
        403,
        "task_identity_rejected",
      );
    },
  };
}
