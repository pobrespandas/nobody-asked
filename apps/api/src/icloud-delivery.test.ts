import { createServer, type Socket } from "node:net";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIcloudOperatorChallengeDelivery,
  ICLOUD_FROM_EMAIL,
  readIcloudMailCredentials,
} from "./icloud-delivery.js";

const credentials = {
  user: "operator@icloud.com",
  appPassword: "test-app-password",
};

function harness() {
  const transport = {
    sendMail: vi.fn(async (_message: unknown) => ({
      accepted: ["operator@example.test"],
      rejected: [] as string[],
    })),
    close: vi.fn(),
  };
  const createTransport = vi.fn(() => transport);
  const deliver = createIcloudOperatorChallengeDelivery({
    credentials,
    fromEmail: ICLOUD_FROM_EMAIL,
    createTransport,
  });
  return { transport, createTransport, deliver };
}

afterEach(() => vi.useRealTimers());

describe("iCloud operator challenge delivery", () => {
  it("requires authenticated STARTTLS and sends only to the invited identity", async () => {
    const { transport, createTransport, deliver } = harness();
    await deliver("operator@example.test", "private-proof");
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.mail.me.com",
        port: 587,
        secure: false,
        requireTLS: true,
        tls: { rejectUnauthorized: true },
        auth: { user: credentials.user, pass: credentials.appPassword },
        logger: false,
        debug: false,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    expect(transport.sendMail).toHaveBeenCalledOnce();
    expect(transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { name: "Nobody Asked", address: ICLOUD_FROM_EMAIL },
        to: { name: "", address: "operator@example.test" },
        text: expect.stringContaining("private-proof"),
        messageId: expect.stringMatching(/^<[a-f0-9]{64}@pobrespandas\.com>$/),
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
    );
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it.each([
    { accepted: [], rejected: [] },
    { accepted: ["another@example.test"], rejected: [] },
    {
      accepted: ["operator@example.test"],
      rejected: ["operator@example.test"],
    },
  ])("rejects missing or partial provider acceptance", async (result) => {
    const { transport, deliver } = harness();
    transport.sendMail.mockResolvedValue(result);
    await expect(
      deliver("operator@example.test", "private-proof"),
    ).rejects.toThrow("operator_challenge_delivery_failed");
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("closes failed connections and removes private provider details", async () => {
    const { transport, deliver } = harness();
    transport.sendMail.mockRejectedValue(
      new Error("private recipient and credential"),
    );
    await expect(
      deliver("operator@example.test", "private-proof"),
    ).rejects.toThrow(/^operator_challenge_delivery_failed$/);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("bounds a stalled send and closes the connection", async () => {
    vi.useFakeTimers();
    const { transport, deliver } = harness();
    transport.sendMail.mockImplementation(() => new Promise(() => {}));
    const result = expect(
      deliver("operator@example.test", "private-proof"),
    ).rejects.toThrow("operator_challenge_delivery_failed");
    await vi.advanceTimersByTimeAsync(15_000);
    await result;
    expect(transport.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("destroys the real SMTP socket at the deadline during an active reply", async () => {
    const sockets = new Set<Socket>();
    let commands = "";
    let closed = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.write("220 fixture ESMTP\r\n");
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      socket.on("data", (data) => {
        commands += data.toString();
        if (!heartbeat) {
          socket.write("250-fixture\r\n");
          heartbeat = setInterval(
            () => socket.write("250-still-waiting\r\n"),
            500,
          );
        }
      });
      socket.on("close", () => {
        closed = true;
        clearInterval(heartbeat);
        sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    try {
      const deliver = createIcloudOperatorChallengeDelivery({
        credentials,
        fromEmail: ICLOUD_FROM_EMAIL,
        createTransport(configuration) {
          return nodemailer.createTransport({
            ...configuration,
            host: "127.0.0.1",
            port: address.port,
          });
        },
      });
      await expect(
        deliver("operator@example.test", "private-proof"),
      ).rejects.toThrow(/^operator_challenge_delivery_failed$/);
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(commands).toContain("EHLO");
      expect(commands).not.toContain("AUTH");
      expect(commands).not.toContain("DATA");
      expect(commands).not.toContain("private-proof");
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);

  it("keeps a stable secret-free Message-ID without promising deduplication", async () => {
    const { transport, deliver } = harness();
    await deliver("operator@example.test", "same-proof");
    await deliver("operator@example.test", "same-proof");
    expect(transport.sendMail.mock.calls[0]?.[0]).toMatchObject({
      messageId: (
        transport.sendMail.mock.calls[1]?.[0] as { messageId: string }
      ).messageId,
    });
  });

  it("rejects sender changes and recipient header injection", async () => {
    expect(() =>
      createIcloudOperatorChallengeDelivery({
        credentials,
        fromEmail: "other@pobrespandas.com",
      }),
    ).toThrow("iCloud sender");
    const { createTransport, deliver } = harness();
    await expect(
      deliver("operator@example.test\r\nBcc: other@example.test", "proof"),
    ).rejects.toThrow("operator_challenge_delivery_failed");
    expect(createTransport).not.toHaveBeenCalled();
  });
});

describe("iCloud secret configuration", () => {
  it("accepts an iCloud login separate from the sender", () => {
    expect(readIcloudMailCredentials(JSON.stringify(credentials))).toEqual(
      credentials,
    );
  });
  it.each([
    "private invalid JSON",
    JSON.stringify({ ...credentials, extra: "private" }),
    JSON.stringify({ ...credentials, user: "operator@example.test" }),
    JSON.stringify({ ...credentials, appPassword: "" }),
    JSON.stringify({ ...credentials, appPassword: "private\npassword" }),
    "null",
  ])("rejects invalid secrets without echoing their contents", (value) => {
    expect(() => readIcloudMailCredentials(value)).toThrow(
      /^ICLOUD_SMTP_CREDENTIALS must contain user and appPassword\.$/,
    );
  });
});
