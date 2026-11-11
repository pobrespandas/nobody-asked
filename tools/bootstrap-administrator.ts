import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import {
  getFirestore,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { digest, requireAdmin } from "../apps/api/src/admin/contracts.js";

export async function bootstrapAdministrator(
  firestore: Firestore,
  input: { operatorId: string; subject: string; verifiedEmail: string },
  at = new Date(),
): Promise<void> {
  requireAdmin(input.subject && input.operatorId && input.verifiedEmail);
  await firestore.runTransaction(async (transaction) => {
    const control = firestore
      .collection("bootstrapControls")
      .doc("administrator");
    const operatorRef = firestore.collection("operators").doc(input.operatorId);
    const [saved, operator] = await Promise.all([
      transaction.get(control),
      transaction.get(operatorRef),
    ]);
    requireAdmin(
      operator.exists &&
        operator.data()?.active !== false &&
        !operator.data()?.disabledAt &&
        !operator.data()?.revokedAt &&
        operator.data()?.normalizedIdentity ===
          input.verifiedEmail.toLowerCase(),
      403,
      "operator_identity_mismatch",
    );
    const bindingId = digest(`https://accounts.google.com:${input.subject}`);
    if (saved.exists) {
      requireAdmin(
        saved.data()?.operatorId === input.operatorId &&
          saved.data()?.bindingId === bindingId,
        409,
        "administrator_already_bootstrapped",
      );
      return;
    }
    transaction.create(control, {
      operatorId: input.operatorId,
      bindingId,
      createdAt: Timestamp.fromDate(at),
    });
    transaction.create(
      firestore.collection("administratorAuthorities").doc(input.operatorId),
      {
        operatorId: input.operatorId,
        grantedAt: Timestamp.fromDate(at),
        revokedAt: null,
      },
    );
    transaction.create(
      firestore.collection("administratorBindings").doc(bindingId),
      {
        operatorId: input.operatorId,
        issuer: "https://accounts.google.com",
        subject: input.subject,
        createdAt: Timestamp.fromDate(at),
        revokedAt: null,
      },
    );
    transaction.create(firestore.collection("auditRecords").doc(), {
      actorType: "system",
      actorId: "administrator-bootstrap",
      action: "administrator.authority_granted",
      subjectType: "operator",
      subjectId: input.operatorId,
      createdAt: Timestamp.fromDate(at),
      expireAt: Timestamp.fromMillis(at.getTime() + 365 * 86400000),
      details: { result: "completed" },
    });
  });
}
async function interactiveAssertion(
  clientId: string,
  clientSecret: string | undefined,
): Promise<string> {
  requireAdmin(clientSecret, 400, "google_client_secret_required");
  const callback = "http://127.0.0.1:4189/auth/callback";
  const client = new OAuth2Client(clientId, clientSecret, callback);
  const state = randomBytes(32).toString("base64url"),
    nonce = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  return new Promise((resolve, reject) => {
    let used = false;
    const server = createServer(async (incoming, outgoing) => {
      try {
        const url = new URL(incoming.url ?? "/", callback);
        requireAdmin(
          incoming.method === "GET" &&
            url.pathname === "/auth/callback" &&
            url.searchParams.get("state") === state &&
            url.searchParams.has("code") &&
            !used,
          400,
          "invalid_bootstrap_callback",
        );
        used = true;
        const { tokens } = await client.getToken({
          code: url.searchParams.get("code")!,
          codeVerifier: verifier,
        });
        requireAdmin(tokens.id_token, 401, "authentication_failed");
        const ticket = await client.verifyIdToken({
          idToken: tokens.id_token,
          audience: clientId,
        });
        requireAdmin(
          ticket.getPayload()?.nonce === nonce,
          401,
          "authentication_failed",
        );
        outgoing.writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        outgoing.end(
          "Google identity received. Check the bootstrap command result. You can close this tab.",
        );
        clearTimeout(timeout);
        server.close();
        resolve(tokens.id_token);
      } catch {
        outgoing.writeHead(400, { "cache-control": "no-store" });
        outgoing.end("Bootstrap confirmation failed.");
        if (used) {
          clearTimeout(timeout);
          server.close();
          reject(new Error("Bootstrap failed."));
        }
      }
    });
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Bootstrap expired."));
    }, 600000);
    server.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("Loopback callback is unavailable."));
    });
    server.listen(4189, "127.0.0.1", () =>
      console.log(
        client.generateAuthUrl({
          scope: ["openid", "email"],
          state,
          nonce,
          prompt: "select_account",
          code_challenge: Buffer.from(digest(verifier), "hex").toString(
            "base64url",
          ),
          code_challenge_method: CodeChallengeMethod.S256,
        }),
      ),
    );
  });
}
async function main() {
  const [operatorId] = process.argv.slice(2);
  const projectId = process.env.NOBODY_ASKED_GCP_PROJECT_ID,
    database = process.env.FIRESTORE_DATABASE_ID,
    audience = process.env.ADMIN_GOOGLE_CLIENT_ID;
  requireAdmin(
    operatorId &&
      projectId &&
      projectId !== "querelo-prod" &&
      database &&
      database !== "(default)" &&
      audience,
    400,
    "explicit_configuration_required",
  );
  const assertion = process.argv.includes("--interactive")
    ? await interactiveAssertion(
        audience,
        process.env.ADMIN_GOOGLE_CLIENT_SECRET,
      )
    : readFileSync(0, "utf8").trim();
  const ticket = await new OAuth2Client().verifyIdToken({
    idToken: assertion,
    audience,
  });
  const payload = ticket.getPayload();
  requireAdmin(
    payload?.email_verified &&
      payload.email &&
      payload.sub &&
      Date.now() / 1000 - payload.iat < 600,
    401,
    "recent_google_assertion_required",
  );
  const app = initializeApp({ projectId, credential: applicationDefault() });
  try {
    await bootstrapAdministrator(getFirestore(app, database), {
      operatorId,
      subject: payload.sub,
      verifiedEmail: payload.email,
    });
    console.log("Administrator authority is bound.");
  } finally {
    await deleteApp(app);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    console.error("Administrator bootstrap failed. No assertion is logged.");
    process.exitCode = 1;
  });
