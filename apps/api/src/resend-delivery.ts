import { createHash } from "node:crypto";

export interface ResendOperatorChallengeDeliveryOptions {
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly endpoint?: string;
}

export function createResendOperatorChallengeDelivery(
  options: ResendOperatorChallengeDeliveryOptions,
) {
  const apiKey = required(options.apiKey, "Resend API key");
  const fromEmail = email(options.fromEmail, "Resend sender email");
  const send = options.fetch ?? globalThis.fetch;
  const endpoint = options.endpoint ?? "https://api.resend.com/emails";

  return async (normalizedIdentity: string, challengeSecret: string) => {
    const recipient = email(normalizedIdentity, "Operator identity");
    const secret = required(challengeSecret, "Operator challenge secret");
    try {
      const response = await send(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "idempotency-key": deliveryKey(recipient, secret),
        },
        body: JSON.stringify({
          from: `Nobody Asked <${fromEmail}>`,
          to: [recipient],
          subject: "Your Nobody Asked operator challenge",
          text: [
            "Use this one-time challenge to continue operator access:",
            "",
            secret,
            "",
            "It expires in 10 minutes.",
            "If you did not request this challenge, ignore this email.",
          ].join("\n"),
          tags: [{ name: "category", value: "operator_challenge" }],
        }),
      });
      if (!response.ok) throw new Error("delivery_rejected");
    } catch {
      throw new Error("operator_challenge_delivery_failed");
    }
  };
}

function deliveryKey(identity: string, secret: string): string {
  return createHash("sha256")
    .update("nobody-asked/operator-challenge\0")
    .update(identity)
    .update("\0")
    .update(secret)
    .digest("hex");
}

function email(value: string, name: string): string {
  const normalized = required(value, name).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`${name} must be an email address.`);
  }
  return normalized;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}
