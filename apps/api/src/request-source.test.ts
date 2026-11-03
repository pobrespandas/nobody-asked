import { describe, expect, it } from "vitest";
import {
  bindRegistrationNetworkSource,
  registrationNetworkSourceKey,
} from "./request-source.js";

describe("registration transport source", () => {
  it("ignores caller-controlled forwarding headers", () => {
    const first = new Request("https://network.test", {
      headers: { "x-forwarded-for": "192.0.2.1" },
    });
    const second = new Request("https://network.test", {
      headers: { "x-forwarded-for": "192.0.2.2" },
    });
    expect(registrationNetworkSourceKey(first)).toBe(
      registrationNetworkSourceKey(second),
    );
    bindRegistrationNetworkSource(first, "192.0.2.1");
    bindRegistrationNetworkSource(second, "192.0.2.2");
    expect(registrationNetworkSourceKey(first)).not.toBe(
      registrationNetworkSourceKey(second),
    );
  });
  it("normalizes mapped IPv4 addresses and hashes the source", () => {
    const first = new Request("https://network.test");
    const second = new Request("https://network.test");
    bindRegistrationNetworkSource(first, "::ffff:192.0.2.1");
    bindRegistrationNetworkSource(second, "192.0.2.1");
    expect(registrationNetworkSourceKey(first)).toBe(
      registrationNetworkSourceKey(second),
    );
    expect(registrationNetworkSourceKey(first)).toMatch(/^[a-f0-9]{64}$/);
  });
});
