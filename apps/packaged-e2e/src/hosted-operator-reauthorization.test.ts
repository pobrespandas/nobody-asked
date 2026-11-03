import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyHostedOperatorReauthorization } from "./hosted-operator-reauthorization.js";
afterEach(() => vi.unstubAllGlobals());
const input = {
  baseUrl: new URL("https://network.test/"),
  origin: "https://operator.test",
  mainOperator: {
    operatorId: "private-main",
    operatorCookie: "__session=private-main-session",
  },
  peerOperator: {
    operatorId: "private-peer",
    operatorCookie: "__session=private-peer-session",
  },
};
describe("memory-only distinct Operator reauthorization verifier", () => {
  it("requires distinct Operator identities before any HTTP request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      verifyHostedOperatorReauthorization({
        ...input,
        peerOperator: input.mainOperator,
      }),
    ).rejects.toThrow(/^Invalid Operator reauthorization input\.$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects an unsafe peer session before any HTTP request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      verifyHostedOperatorReauthorization({
        ...input,
        peerOperator: {
          ...input.peerOperator,
          operatorCookie: "__session=private\r\nsecret",
        },
      }),
    ).rejects.toThrow(/^Invalid Operator reauthorization input\.$/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("returns only public synthetic metadata on discovery failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(
          "private-main-session private-peer-session private-main private-peer",
        );
      }),
    );
    const report = await verifyHostedOperatorReauthorization(input);
    expect(report).toMatchObject({
      result: "fail",
      phase: "discovery",
      agentId: null,
      cleanup: "not-created",
    });
    expect(JSON.stringify(report)).not.toMatch(/private-main|private-peer/);
  });
});
