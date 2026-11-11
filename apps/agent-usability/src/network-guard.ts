import { createHash } from "node:crypto";

const guardUrl = process.env.NOBODY_GUARD_URL;
const guardToken = process.env.NOBODY_GUARD_TOKEN;
delete process.env.NOBODY_GUARD_URL;
delete process.env.NOBODY_GUARD_TOKEN;
if (!guardUrl || !guardToken)
  throw new Error("Network guard is not configured.");
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const body = request.method === "GET" ? "" : await request.clone().text();
  let recoveryOperation: string | undefined;
  if (body) {
    try {
      recoveryOperation = (JSON.parse(body) as { operation?: string })
        .operation;
    } catch {
      throw new Error("Only JSON request bodies are available.");
    }
  }
  const permission = await originalFetch(guardUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${guardToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url: request.url,
      method: request.method,
      recoveryOperation,
      idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
      digest: createHash("sha256").update(body).digest("hex"),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!permission.ok)
    throw new Error("Experiment network policy denied this request.");
  return originalFetch(request, { redirect: "error" });
};
