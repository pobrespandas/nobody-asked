import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer/index.js";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

export const ICLOUD_FROM_EMAIL = "nobodyasked@pobrespandas.com";

export interface IcloudMailCredentials {
  readonly user: string;
  readonly appPassword: string;
}

interface MailTransport {
  sendMail(message: Mail.Options): Promise<{
    accepted?: unknown[];
    rejected?: unknown[];
  }>;
  close(): void;
}

export function readIcloudMailCredentials(
  value: string,
): IcloudMailCredentials {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "appPassword,user" ||
      typeof record.user !== "string" ||
      !/^[^\s@]+@(icloud\.com|me\.com|mac\.com)$/i.test(record.user) ||
      typeof record.appPassword !== "string" ||
      record.appPassword.length < 8 ||
      record.appPassword.length > 256 ||
      /\s/.test(record.appPassword)
    )
      throw new Error();
    return Object.freeze({
      user: record.user.toLowerCase(),
      appPassword: record.appPassword,
    });
  } catch {
    throw new Error(
      "ICLOUD_SMTP_CREDENTIALS must contain user and appPassword.",
    );
  }
}

export function createIcloudOperatorChallengeDelivery(options: {
  readonly credentials: IcloudMailCredentials;
  readonly fromEmail: string;
  readonly createTransport?: (options: SMTPTransport.Options) => MailTransport;
}) {
  if (options.fromEmail !== ICLOUD_FROM_EMAIL)
    throw new Error("The iCloud sender must be nobodyasked@pobrespandas.com.");
  const createTransport =
    options.createTransport ??
    ((configuration: SMTPTransport.Options) =>
      nodemailer.createTransport(configuration));

  return async (identity: string, challengeSecret: string): Promise<void> => {
    let transport: MailTransport | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let socket: Socket | undefined;
    let finished = false;
    try {
      if (
        !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(identity) ||
        !challengeSecret
      )
        throw new Error();
      transport = createTransport({
        host: "smtp.mail.me.com",
        getSocket(configuration, callback) {
          if (finished) {
            callback(new Error("operator_challenge_delivery_failed"), {});
            return;
          }
          socket = createConnection({
            host: configuration.host ?? "smtp.mail.me.com",
            port: Number(configuration.port ?? 587),
          });
          const connection = socket;
          const onError = (error: Error) => callback(error, {});
          connection.once("error", onError);
          connection.setTimeout(5_000, () =>
            connection.destroy(new Error("SMTP connection timeout")),
          );
          connection.once("connect", () => {
            connection.removeListener("error", onError);
            connection.setTimeout(0);
            callback(null, { connection });
          });
        },
        port: 587,
        secure: false,
        requireTLS: true,
        tls: { rejectUnauthorized: true },
        auth: {
          user: options.credentials.user,
          pass: options.credentials.appPassword,
        },
        connectionTimeout: 5_000,
        greetingTimeout: 5_000,
        socketTimeout: 10_000,
        logger: false,
        debug: false,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      const result = await Promise.race([
        transport.sendMail({
          from: { name: "Nobody Asked", address: ICLOUD_FROM_EMAIL },
          to: { name: "", address: identity },
          subject: "Your Nobody Asked operator challenge",
          text: [
            "Use this one-time challenge to continue operator access:",
            "",
            challengeSecret,
            "",
            "It expires in 10 minutes.",
            "If you did not request this challenge, ignore this email.",
          ].join("\n"),
          messageId: `<${createHash("sha256")
            .update("nobody-asked/operator-challenge\0")
            .update(identity)
            .update("\0")
            .update(challengeSecret)
            .digest("hex")}@pobrespandas.com>`,
          disableFileAccess: true,
          disableUrlAccess: true,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error()), 15_000);
        }),
      ]);
      if (
        result.accepted?.length !== 1 ||
        result.accepted[0] !== identity ||
        (result.rejected?.length ?? 0) !== 0
      )
        throw new Error();
    } catch {
      throw new Error("operator_challenge_delivery_failed");
    } finally {
      finished = true;
      clearTimeout(timer);
      socket?.destroy();
      try {
        transport?.close();
      } catch {
        // Connection cleanup must not expose provider errors.
      }
    }
  };
}
