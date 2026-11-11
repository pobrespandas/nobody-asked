import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { date, digest, requireAdmin, type Principal } from "./contracts.js";
import type { AdminConfig } from "./config.js";

export interface GoogleIdentity {
  issuer: string;
  subject: string;
  email: string;
}
export interface GoogleVerifier {
  authorization(state: string, nonce: string, verifier: string): string;
  exchange(
    code: string,
    nonce: string,
    verifier: string,
  ): Promise<GoogleIdentity>;
}
export function googleVerifier(config: AdminConfig): GoogleVerifier {
  const client = new OAuth2Client(
    config.googleClientId,
    config.googleClientSecret,
    `${config.origin}/admin/auth/callback`,
  );
  return {
    authorization(state, nonce, verifier) {
      return client.generateAuthUrl({
        scope: ["openid", "email"],
        state,
        nonce,
        prompt: "select_account",
        code_challenge: Buffer.from(digest(verifier), "hex").toString(
          "base64url",
        ),
        code_challenge_method: CodeChallengeMethod.S256,
      });
    },
    async exchange(code, nonce, verifier) {
      const { tokens } = await client.getToken({
        code,
        codeVerifier: verifier,
      });
      requireAdmin(tokens.id_token, 401, "authentication_failed");
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: config.googleClientId,
      });
      const payload = ticket.getPayload();
      requireAdmin(
        payload &&
          ["https://accounts.google.com", "accounts.google.com"].includes(
            payload.iss,
          ) &&
          payload.nonce === nonce &&
          payload.email_verified &&
          payload.sub &&
          payload.email,
        401,
        "authentication_failed",
      );
      return {
        issuer: "https://accounts.google.com",
        subject: payload.sub,
        email: payload.email,
      };
    },
  };
}
export function cookie(request: Request, name: string): string | null {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : null;
}
export const sessionCookie = (token: string, maxAge = 43200) =>
  `__session=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
function equal(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class AdminAuth {
  constructor(
    readonly firestore: Firestore,
    readonly config: AdminConfig,
    readonly google: GoogleVerifier,
    readonly now = () => new Date(),
  ) {}

  async begin(
    request: Request,
    intent: string | null = null,
  ): Promise<Response> {
    const principal = intent ? await this.authenticate(request) : null;
    const state = randomBytes(32).toString("base64url"),
      nonce = randomBytes(32).toString("base64url"),
      verifier = randomBytes(32).toString("base64url"),
      browser = randomBytes(32).toString("base64url");
    await this.firestore.runTransaction(async (transaction) => {
      const window = Math.floor(this.now().getTime() / 600000);
      const limitRef = this.firestore
        .collection("adminAuthLimits")
        .doc(`google-${window}`);
      const saved = await transaction.get(limitRef);
      requireAdmin(
        Number(saved.data()?.count ?? 0) < 10,
        429,
        "authentication_rate_limited",
      );
      transaction.set(limitRef, {
        count: Number(saved.data()?.count ?? 0) + 1,
        expireAt: Timestamp.fromMillis((window + 2) * 600000),
      });
      transaction.create(
        this.firestore.collection("adminOauthStates").doc(digest(state)),
        {
          nonce,
          verifier,
          browserDigest: digest(browser),
          operatorId: principal?.operatorId ?? null,
          intent,
          createdAt: Timestamp.fromDate(this.now()),
          expiresAt: Timestamp.fromMillis(this.now().getTime() + 600000),
        },
      );
    });
    return new Response(null, {
      status: 303,
      headers: {
        location: this.google.authorization(state, nonce, verifier),
        "set-cookie": `__session=oauth.${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      },
    });
  }

  async complete(request: Request): Promise<Response> {
    const url = new URL(request.url),
      state = url.searchParams.get("state"),
      code = url.searchParams.get("code");
    requireAdmin(
      state && code && state.length <= 200 && code.length <= 4096,
      401,
      "authentication_failed",
    );
    const ref = this.firestore
      .collection("adminOauthStates")
      .doc(digest(state));
    const saved = await ref.get(),
      data = saved.data();
    const browser = cookie(request, "__session");
    requireAdmin(
      data &&
        !data.consumedAt &&
        date(data.expiresAt)!.getTime() > this.now().getTime() &&
        browser?.startsWith("oauth.") &&
        equal(data.browserDigest, digest(browser.slice(6))),
      401,
      "authentication_failed",
    );
    const identity = await this.google.exchange(
      code,
      String(data.nonce),
      String(data.verifier),
    );
    const bindingRef = this.firestore
      .collection("administratorBindings")
      .doc(digest(`${identity.issuer}:${identity.subject}`));
    const tokenId = randomUUID(),
      secret = randomBytes(32).toString("base64url"),
      csrf = randomBytes(32).toString("base64url");
    await this.firestore.runTransaction(async (transaction) => {
      const [stateSnapshot, binding] = await Promise.all([
        transaction.get(ref),
        transaction.get(bindingRef),
      ]);
      requireAdmin(
        stateSnapshot.exists &&
          !stateSnapshot.data()?.consumedAt &&
          date(stateSnapshot.data()?.expiresAt)!.getTime() >
            this.now().getTime(),
        401,
        "authentication_failed",
      );
      const operatorId = binding.data()?.operatorId;
      requireAdmin(
        binding.exists &&
          !binding.data()?.revokedAt &&
          typeof operatorId === "string" &&
          (!data.operatorId || data.operatorId === operatorId),
        403,
        "administrator_required",
      );
      const [authority, operator] = await Promise.all([
        transaction.get(
          this.firestore.collection("administratorAuthorities").doc(operatorId),
        ),
        transaction.get(this.firestore.collection("operators").doc(operatorId)),
      ]);
      requireAdmin(
        authority.exists &&
          !authority.data()?.revokedAt &&
          operator.exists &&
          operator.data()?.active !== false &&
          !operator.data()?.disabledAt &&
          !operator.data()?.revokedAt,
        403,
        "administrator_required",
      );
      transaction.update(ref, {
        consumedAt: Timestamp.fromDate(this.now()),
        verifier: null,
        nonce: null,
      });
      transaction.create(
        this.firestore.collection("operatorSessions").doc(tokenId),
        {
          operatorId,
          secretDigest: digest(secret),
          origin: this.config.origin,
          authenticatedAt: Timestamp.fromDate(this.now()),
          expiresAt: Timestamp.fromMillis(this.now().getTime() + 43200000),
          revokedAt: null,
          adminCsrf: csrf,
          adminDeletionIntent: data.intent ?? null,
          adminGoogleBinding: bindingRef.id,
        },
      );
      transaction.create(this.firestore.collection("auditRecords").doc(), {
        actorType: "administrator",
        actorId: operatorId,
        action: "administrator.authenticated",
        subjectType: "operator",
        subjectId: operatorId,
        createdAt: Timestamp.fromDate(this.now()),
        details: { result: "completed" },
        expireAt: Timestamp.fromMillis(this.now().getTime() + 365 * 86400000),
      });
    });
    return new Response(null, {
      status: 303,
      headers: {
        location: data.intent
          ? `/admin/deletion?intent=${encodeURIComponent(data.intent)}`
          : "/admin",
        "set-cookie": sessionCookie(`${tokenId}.${secret}`),
      },
    });
  }

  async authenticate(request: Request): Promise<Principal> {
    const token = cookie(request, "__session"),
      parts = token?.split(".");
    requireAdmin(
      parts?.length === 2 && /^[a-zA-Z0-9-]{1,100}$/.test(parts[0]!),
      401,
      "authentication_required",
    );
    const snapshot = await this.firestore
        .collection("operatorSessions")
        .doc(parts[0]!)
        .get(),
      data = snapshot.data();
    requireAdmin(
      data &&
        !data.revokedAt &&
        date(data.expiresAt) &&
        date(data.expiresAt)!.getTime() > this.now().getTime() &&
        data.origin === this.config.origin &&
        equal(String(data.secretDigest), digest(parts[1]!)) &&
        data.adminGoogleBinding &&
        typeof data.adminCsrf === "string",
      401,
      "authentication_required",
    );
    const [authority, binding, operator] = await Promise.all([
      this.firestore
        .collection("administratorAuthorities")
        .doc(String(data.operatorId))
        .get(),
      this.firestore
        .collection("administratorBindings")
        .doc(String(data.adminGoogleBinding))
        .get(),
      this.firestore.collection("operators").doc(String(data.operatorId)).get(),
    ]);
    requireAdmin(
      authority.exists &&
        !authority.data()?.revokedAt &&
        binding.exists &&
        !binding.data()?.revokedAt &&
        binding.data()?.operatorId === data.operatorId &&
        operator.exists &&
        operator.data()?.active !== false &&
        !operator.data()?.disabledAt &&
        !operator.data()?.revokedAt,
      403,
      "administrator_required",
    );
    return {
      operatorId: data.operatorId,
      sessionId: snapshot.id,
      authenticatedAt: date(data.authenticatedAt)!,
      csrf: data.adminCsrf,
      deletionIntent: data.adminDeletionIntent ?? null,
    };
  }

  validateWrite(
    request: Request,
    principal: Principal,
    csrf: unknown,
    recent = true,
  ): void {
    requireAdmin(
      request.headers.get("origin") === this.config.origin &&
        typeof csrf === "string" &&
        equal(csrf, principal.csrf),
      403,
      "request_rejected",
    );
    requireAdmin(
      !recent ||
        this.now().getTime() - principal.authenticatedAt.getTime() < 600000,
      403,
      "recent_authentication_required",
    );
  }
}
