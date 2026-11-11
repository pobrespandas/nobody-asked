import { createHash, timingSafeEqual } from "node:crypto";
import { Timestamp, type DocumentData } from "firebase-admin/firestore";
export function credentialIsActive(data: DocumentData | undefined, at: Date) {
  if (!data || data.revokedAt) return false;
  return (
    !data.expiresAt ||
    (data.expiresAt instanceof Timestamp
      ? data.expiresAt.toDate()
      : (data.expiresAt as Date)
    ).getTime() > at.getTime()
  );
}
export function parseCredentialToken(
  token: string,
): { readonly credentialId: string; readonly secret: string } | null {
  const separator = token.indexOf(".");
  if (separator < 1 || separator === token.length - 1) return null;
  const credentialId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (credentialId.length > 128 || secret.length > 512) return null;
  return Object.freeze({ credentialId, secret });
}
export function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}
