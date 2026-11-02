import { describe, expect, it, vi } from "vitest";

import { createResendOperatorChallengeDelivery } from "./resend-delivery.js";

describe("Resend operator challenge delivery", () => {
  it("sends one private challenge with a secret-free idempotency key", async () => {
    const send = vi.fn<typeof fetch>(
      async () => new Response('{"id":"email-1"}'),
    );
    const deliver = createResendOperatorChallengeDelivery({
      apiKey: "resend-secret",
      fromEmail: "access@nobodyasked.pobrespandas.com",
      fetch: send,
    });

    await deliver("operator@example.test", "one-time-challenge");

    expect(send).toHaveBeenCalledOnce();
    const [url, optionalInit] = send.mock.calls[0]!;
    const init = optionalInit!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({
      authorization: "Bearer resend-secret",
      "content-type": "application/json",
    });
    const headers = init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toMatch(/^[a-f0-9]{64}$/);
    expect(headers["idempotency-key"]).not.toContain("one-time-challenge");
    expect(JSON.parse(String(init.body))).toEqual({
      from: "Nobody Asked <access@nobodyasked.pobrespandas.com>",
      to: ["operator@example.test"],
      subject: "Your Nobody Asked operator challenge",
      text: expect.stringContaining("one-time-challenge"),
      tags: [{ name: "category", value: "operator_challenge" }],
    });
  });

  it("uses a stable key for an exact delivery retry", async () => {
    const send = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 202 }),
    );
    const deliver = createResendOperatorChallengeDelivery({
      apiKey: "resend-secret",
      fromEmail: "access@nobodyasked.pobrespandas.com",
      fetch: send,
    });

    await deliver("operator@example.test", "same-challenge");
    await deliver("operator@example.test", "same-challenge");

    const first = send.mock.calls[0]![1]!.headers as Record<string, string>;
    const second = send.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(first["idempotency-key"]).toBe(second["idempotency-key"]);
  });

  it("fails closed without exposing the provider response", async () => {
    const deliver = createResendOperatorChallengeDelivery({
      apiKey: "resend-secret",
      fromEmail: "access@nobodyasked.pobrespandas.com",
      fetch: async () =>
        new Response('{"message":"provider-private-detail"}', {
          status: 403,
        }),
    });

    await expect(
      deliver("operator@example.test", "one-time-challenge"),
    ).rejects.toThrow("operator_challenge_delivery_failed");
  });

  it("fails closed without exposing a network error", async () => {
    const deliver = createResendOperatorChallengeDelivery({
      apiKey: "resend-secret",
      fromEmail: "access@nobodyasked.pobrespandas.com",
      fetch: async () => {
        throw new Error("private network detail");
      },
    });

    await expect(
      deliver("operator@example.test", "one-time-challenge"),
    ).rejects.toThrow("operator_challenge_delivery_failed");
  });

  it("rejects missing credentials and invalid addresses", () => {
    expect(() =>
      createResendOperatorChallengeDelivery({
        apiKey: "",
        fromEmail: "access@nobodyasked.pobrespandas.com",
      }),
    ).toThrow("Resend API key");
    expect(() =>
      createResendOperatorChallengeDelivery({
        apiKey: "resend-secret",
        fromEmail: "not-an-email",
      }),
    ).toThrow("sender email");
  });
});
