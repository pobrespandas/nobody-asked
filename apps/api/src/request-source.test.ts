import { describe, expect, it } from "vitest";
import {
  bindRegistrationNetworkSource,
  registrationNetworkSourceKey,
} from "./request-source.js";

describe("registration transport source", () => {
  it("keeps one proxy peer in one bucket despite spoofed source headers", () => {
    const requests = ["192.0.2.1", "198.51.100.1"].map((address) => {
      const request = new Request("https://network.test", {
        headers: {
          "x-forwarded-for": `${address}, 203.0.113.1`,
          forwarded: `for=${address};proto=https`,
          "x-real-ip": address,
          "cf-connecting-ip": address,
          "fastly-client-ip": address,
        },
      });
      bindRegistrationNetworkSource(request, "169.254.1.1");
      return request;
    });
    expect(registrationNetworkSourceKey(requests[0]!)).toBe(
      registrationNetworkSourceKey(requests[1]!),
    );
  });

  it.each([
    undefined,
    "",
    "unknown",
    "192.0.2.1,198.51.100.1",
    "192.0.2.1:8080",
  ])(
    "uses the shared unknown bucket for invalid transport address %s",
    (address) => {
      const request = new Request("https://network.test", {
        headers: { "x-forwarded-for": "192.0.2.1" },
      });
      bindRegistrationNetworkSource(request, address);
      expect(registrationNetworkSourceKey(request)).toBe(
        registrationNetworkSourceKey(new Request("https://network.test")),
      );
    },
  );
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
