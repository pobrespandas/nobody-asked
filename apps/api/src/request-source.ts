import { createHash } from "node:crypto";
import { isIP } from "node:net";

const sources = new WeakMap<Request, string>();

export function bindRegistrationNetworkSource(
  request: Request,
  address: string | undefined,
): void {
  const normalized = address?.startsWith("::ffff:")
    ? address.slice(7)
    : address;
  sources.set(request, normalized && isIP(normalized) ? normalized : "unknown");
}

export function registrationNetworkSourceKey(request: Request): string {
  return createHash("sha256")
    .update(`registration-source-v1:${sources.get(request) ?? "unknown"}`)
    .digest("hex");
}
