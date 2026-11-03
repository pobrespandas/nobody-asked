import { deleteApp } from "firebase-admin/app";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLocalFirestoreAdmin,
  resetLocalFirestore,
} from "@nobody-asked/firestore-support";
import type { LocalFirestoreAdmin } from "@nobody-asked/firestore-support";

import { createFirestoreApiAdapters } from "./firestore-adapters.js";
import { FIRESTORE_PUBLISH_OPERATION_BUDGET } from "./firestore-adapters.js";
import { FirestoreOperatorAuthorizations } from "./operator-authorizations.js";
import {
  InvalidFeedCursorError,
  InvalidFeedLimitError,
} from "@nobody-asked/feeds";

vi.setConfig({ testTimeout: 20_000 });

describe.skipIf(process.env.RUN_FIRESTORE_EMULATOR_TESTS !== "1")(
  "Firestore persistence integration",
  () => {
    const at = new Date("2026-11-01T12:00:00.000Z");
    const registrationKeys = generateKeyPairSync("ed25519");
    const recoveryPublicKey = registrationKeys.publicKey.export({
      format: "jwk",
    }) as Ed25519PublicJwk;
    let local: LocalFirestoreAdmin;
    let adapters: ReturnType<typeof createFirestoreApiAdapters>;

    beforeAll(async () => {
      local = createLocalFirestoreAdmin({
        appName: "firestore-persistence-tests",
      });
      adapters = createFirestoreApiAdapters({
        firestore: local.firestore,
        digestCredentialSecret: (secret) => `digest:${secret}`,
        safetyPolicy: {
          async authorizeAgentWrite(transaction, agentId) {
            const block = await transaction.get(
              local.firestore.collection("safetyBlocks").doc(agentId),
            );
            if (block.exists) throw new Error("safety_blocked");
          },
        },
      });
      await resetLocalFirestore();
    });
    beforeEach(async () => resetLocalFirestore());
    afterAll(async () => deleteApp(local.app));

    function autonomousAdapters() {
      return createFirestoreApiAdapters({
        firestore: local.firestore,
        digestCredentialSecret: (secret) =>
          createHash("sha256").update(secret).digest("base64url"),
        safetyPolicy: { async authorizeAgentWrite() {} },
      });
    }

    function autonomousRegistration(
      registrationId: string,
      handle = "autonomous_agent",
    ) {
      const challenge = `challenge-${registrationId}`;
      const inputFingerprint = `fingerprint-${registrationId}`;
      const attempt = createAgentRegistrationAttempt({
        id: registrationId,
        inputFingerprint,
        recoveryPublicKey,
        challenge,
        createdAt: at,
      });
      const signature = sign(
        null,
        Buffer.from(registrationProofMessage(attempt), "utf8"),
        registrationKeys.privateKey,
      ).toString("base64url");
      return {
        start: {
          registrationId,
          handle,
          displayName: "Autonomous Agent",
          description: "Registers without an Operator.",
          inputFingerprint,
          recoveryPublicKey,
          challenge,
          createdAt: at,
        },
        complete: {
          registrationId,
          challenge,
          signature,
          credentialSecretDigest: `credential-digest-${registrationId}`,
          occurredAt: new Date(at.getTime() + 1_000),
          correlationId: `correlation-${registrationId}`,
        },
      };
    }

    it("limits concurrent incomplete registrations and releases completed capacity", async () => {
      const secure = autonomousAdapters();
      const proofs = Array.from({ length: 6 }, (_, index) =>
        autonomousRegistration(`bounded-${index}`, `bounded_${index}`),
      );
      const results = await Promise.allSettled(
        proofs.map((proof) =>
          secure.store.startAgentRegistration({
            ...proof.start,
            networkSourceKey: "source-one",
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(5);
      expect(
        results.find((result) => result.status === "rejected"),
      ).toMatchObject({
        reason: {
          code: "registration_network_source_capacity_reached",
          retryAt: null,
        },
      });
      const accepted = results.findIndex(
        (result) => result.status === "fulfilled",
      );
      await secure.store.completeAgentRegistration(proofs[accepted]!.complete);
      const next = autonomousRegistration("bounded-next", "bounded_next");
      await expect(
        secure.store.startAgentRegistration({
          ...next.start,
          networkSourceKey: "source-one",
        }),
      ).resolves.toMatchObject({ created: true });
      const global = await local.firestore
        .collection("registrationControls")
        .doc("global")
        .get();
      expect(global.data()?.pending).toHaveLength(5);
      const expired = autonomousRegistration(
        "bounded-expired",
        "bounded_expired",
      );
      await expect(
        secure.store.startAgentRegistration({
          ...expired.start,
          networkSourceKey: "source-one",
          createdAt: new Date(at.getTime() + 600_001),
        }),
      ).resolves.toMatchObject({ created: true });
      expect(
        (
          await local.firestore
            .collection("registrationControls")
            .doc("global")
            .get()
        ).data()?.pending,
      ).toHaveLength(1);
    }, 20_000);

    it("persists the registration circuit and expires capacity without cleanup jobs", async () => {
      const secure = autonomousAdapters();
      const control = local.firestore
        .collection("registrationControls")
        .doc("global");
      await control.set({ circuitOpen: true });
      const proof = autonomousRegistration("circuit", "circuit_agent");
      await expect(
        secure.store.startAgentRegistration(proof.start),
      ).rejects.toMatchObject({
        code: "registration_circuit_open",
        retryAt: null,
      });
      await control.set({
        circuitOpen: false,
        count: 500,
        windowStartedAt: Timestamp.fromDate(at),
        pending: [],
      });
      await expect(
        secure.store.startAgentRegistration(proof.start),
      ).rejects.toMatchObject({
        code: "registration_global_limited",
        retryAt: new Date(at.getTime() + 600_000),
      });
      await expect(
        secure.store.startAgentRegistration({
          ...proof.start,
          createdAt: new Date(at.getTime() + 600_001),
        }),
      ).resolves.toMatchObject({ created: true });
    });

    it("bounds global capacity and returns a source window retry time", async () => {
      const secure = autonomousAdapters();
      const global = local.firestore
        .collection("registrationControls")
        .doc("global");
      const expiresAt = Timestamp.fromDate(new Date(at.getTime() + 600_000));
      await global.set({
        pending: Array.from({ length: 100 }, (_, id) => ({
          id: String(id),
          expiresAt,
        })),
      });
      const proof = autonomousRegistration(
        "global-capacity",
        "global_capacity",
      );
      await expect(
        secure.store.startAgentRegistration(proof.start),
      ).rejects.toMatchObject({
        code: "registration_global_capacity_reached",
        retryAt: null,
      });
      await global.set({ pending: [] });
      const source = createHash("sha256").update("source-window").digest("hex");
      await local.firestore
        .collection("registrationControls")
        .doc(`source-${source}`)
        .set({
          count: 10,
          windowStartedAt: Timestamp.fromDate(at),
          pending: [],
        });
      await expect(
        secure.store.startAgentRegistration({
          ...proof.start,
          networkSourceKey: "source-window",
        }),
      ).rejects.toMatchObject({
        code: "registration_network_source_limited",
        retryAt: new Date(at.getTime() + 600_000),
      });
    });

    async function registeredAutonomousAgent() {
      const secure = autonomousAdapters();
      const proof = autonomousRegistration("registration-recovery");
      await secure.store.startAgentRegistration(proof.start);
      const result = await secure.store.completeAgentRegistration(
        proof.complete,
      );
      return { secure, agentId: result.registration.agentId };
    }

    function recoveryCompletion(input: {
      agentId: string;
      challengeId: string;
      operation: "replace_credential" | "replace_recovery_key" | "stop_agent";
      idempotencyKey: string;
      privateKey: typeof registrationKeys.privateKey;
      recoveryPublicKey?: Ed25519PublicJwk;
      credentialId?: string;
    }) {
      const challenge = `challenge-${input.challengeId}`;
      const inputFingerprint = agentRecoveryInputFingerprint(
        input.operation,
        input.recoveryPublicKey,
      );
      const proof = createAgentRecoveryChallenge({
        id: input.challengeId,
        agentId: input.agentId,
        operation: input.operation,
        inputFingerprint,
        challenge,
        createdAt: at,
      });
      const signature = sign(
        null,
        Buffer.from(recoveryProofMessage(proof), "utf8"),
        input.privateKey,
      ).toString("base64url");
      return {
        start: {
          agentId: input.agentId,
          challengeId: input.challengeId,
          operation: input.operation,
          inputFingerprint,
          idempotencyKey: input.idempotencyKey,
          challenge,
          createdAt: at,
        },
        complete: {
          agentId: input.agentId,
          challengeId: input.challengeId,
          operation: input.operation,
          inputFingerprint,
          idempotencyKey: input.idempotencyKey,
          challenge,
          signature,
          ...(input.credentialId
            ? {
                credentialId: input.credentialId,
                credentialSecretDigest: `digest-${input.credentialId}`,
              }
            : {}),
          ...(input.recoveryPublicKey
            ? { recoveryPublicKey: input.recoveryPublicKey }
            : {}),
          occurredAt: new Date(at.getTime() + 2_000),
          correlationId: `correlation-${input.challengeId}`,
        },
      };
    }

    async function authorizationFixture() {
      const secure = autonomousAdapters();
      const registration = autonomousRegistration(
        "optional-control-registration",
      );
      await secure.store.startAgentRegistration(registration.start);
      const created = await secure.store.completeAgentRegistration({
        ...registration.complete,
        credentialSecretDigest: createHash("sha256")
          .update("authorization-secret")
          .digest("base64url"),
      });
      const agentId = created.registration.agentId;
      const now = new Date(at.getTime() + 3_000);
      const auth = {
        authenticatedAgentId: agentId,
        credentialId: created.registration.credentialId,
        credentialSecret: `${created.registration.credentialId}.authorization-secret`,
        occurredAt: now,
      };
      for (const id of ["operator-one", "operator-two"]) {
        await local.firestore
          .collection("operators")
          .doc(id)
          .set({ createdAt: Timestamp.fromDate(at) });
        await local.firestore
          .collection("operatorSessions")
          .doc(`session-${id}`)
          .set({
            operatorId: id,
            secretDigest: createHash("sha256")
              .update("session-secret")
              .digest("base64url"),
            origin: "https://operator.test",
            authenticatedAt: Timestamp.fromDate(at),
            expiresAt: Timestamp.fromDate(new Date(at.getTime() + 3_600_000)),
            revokedAt: null,
          });
      }
      const create = {
        ...auth,
        operatorId: "operator-one",
        authorizationId: "authorization-one",
        ifRevision: 0,
        idempotencyKey: "create-one",
        correlationId: "create-one",
      };
      const accept = {
        operatorId: "operator-one",
        sessionSecret: "session-operator-one.session-secret",
        origin: "https://operator.test",
        authorizationId: "authorization-one",
        idempotencyKey: "accept-one",
        occurredAt: now,
        correlationId: "accept-one",
      };
      return { secure, agentId, auth, create, accept, now };
    }

    it("grants exclusive optional authority only after acceptance and permits a distinct Operator after removal", async () => {
      const { secure, agentId, auth, create, accept } =
        await authorizationFixture();
      expect(
        await secure.store.readAgentOperatorAuthorization(auth),
      ).toMatchObject({ revision: 0, authorization: null });
      await secure.store.createAgentOperatorAuthorizationIdempotently(create);
      await expect(
        secure.store.runOperatorAgentControl({
          operatorId: "operator-one",
          agentId,
          operation: "stop",
          occurredAt: auth.occurredAt,
          correlationId: "pending-stop",
        }),
      ).rejects.toMatchObject({ code: "operator_control_denied" });
      await secure.store.acceptAgentOperatorAuthorizationIdempotently(accept);
      expect(
        await secure.store.readAgentOperatorAuthorization(auth),
      ).toMatchObject({
        revision: 2,
        authorization: { operatorId: "operator-one", status: "active" },
      });
      const removal = {
        ...auth,
        ifRevision: 2,
        idempotencyKey: "remove-one",
        correlationId: "remove-one",
      };
      await secure.store.removeAgentOperatorAuthorizationIdempotently(removal);
      const state = await secure.store.readAgentOperatorAuthorization(auth);
      expect(state).toMatchObject({ revision: 3, authorization: null });
      await secure.store.acceptAgentOperatorAuthorizationIdempotently(accept);
      await secure.store.createAgentOperatorAuthorizationIdempotently(create);
      expect(await secure.store.readAgentOperatorAuthorization(auth)).toEqual(
        state,
      );
      await secure.store.createAgentOperatorAuthorizationIdempotently({
        ...create,
        operatorId: "operator-two",
        authorizationId: "authorization-two",
        ifRevision: 3,
        idempotencyKey: "create-two",
      });
      await secure.store.acceptAgentOperatorAuthorizationIdempotently({
        ...accept,
        operatorId: "operator-two",
        sessionSecret: "session-operator-two.session-secret",
        authorizationId: "authorization-two",
        idempotencyKey: "accept-two",
      });
      expect(
        await secure.store.readAgentOperatorAuthorization(auth),
      ).toMatchObject({
        revision: 5,
        authorization: { operatorId: "operator-two", status: "active" },
      });
      await expect(
        secure.store.exportPortableAgent({
          agentId,
          operatorId: "operator-one",
          exportedAt: auth.occurredAt,
        }),
      ).rejects.toMatchObject({ code: "operator_control_denied" });
      const exported = await secure.store.exportPortableAgent({
        agentId,
        actorAgentId: agentId,
        exportedAt: auth.occurredAt,
      });
      expect(JSON.stringify(exported)).not.toContain("operator-two");
    });

    it("rejects wrong targets, stale revisions, expired acceptance and invalid sessions without partial authority", async () => {
      const { secure, auth, create, accept, now } =
        await authorizationFixture();
      await expect(
        secure.store.createAgentOperatorAuthorizationIdempotently({
          ...create,
          operatorId: "missing-operator",
        }),
      ).rejects.toMatchObject({ code: "operator_authorization_unavailable" });
      await secure.store.createAgentOperatorAuthorizationIdempotently(create);
      await expect(
        secure.store.createAgentOperatorAuthorizationIdempotently({
          ...create,
          operatorId: "operator-two",
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        secure.store.removeAgentOperatorAuthorizationIdempotently({
          ...auth,
          ifRevision: 0,
          idempotencyKey: "stale-remove",
          correlationId: "stale-remove",
        }),
      ).rejects.toMatchObject({ code: "operator_authorization_conflict" });
      await expect(
        secure.store.acceptAgentOperatorAuthorizationIdempotently({
          ...accept,
          operatorId: "operator-two",
          sessionSecret: "session-operator-two.session-secret",
        }),
      ).rejects.toMatchObject({ code: "operator_authorization_unavailable" });
      await expect(
        secure.store.acceptAgentOperatorAuthorizationIdempotently({
          ...accept,
          origin: "https://wrong.test",
        }),
      ).rejects.toMatchObject({ code: "operator_authentication_rejected" });
      await local.firestore
        .collection("operatorSessions")
        .doc("session-operator-one")
        .update({
          authenticatedAt: Timestamp.fromDate(
            new Date(now.getTime() + 600_000),
          ),
        });
      await expect(
        secure.store.acceptAgentOperatorAuthorizationIdempotently({
          ...accept,
          occurredAt: new Date(now.getTime() + 600_000),
        }),
      ).rejects.toMatchObject({ code: "operator_authorization_unavailable" });
      await local.firestore
        .collection("operatorSessions")
        .doc("session-operator-one")
        .update({ authenticatedAt: Timestamp.fromDate(at) });
      expect(
        await secure.store.readAgentOperatorAuthorization(auth),
      ).toMatchObject({ revision: 1, authorization: { status: "pending" } });
      await secure.store.removeAgentOperatorAuthorizationIdempotently({
        ...auth,
        ifRevision: 1,
        idempotencyKey: "cancel",
        correlationId: "cancel",
      });
      await expect(
        secure.store.acceptAgentOperatorAuthorizationIdempotently(accept),
      ).rejects.toMatchObject({ code: "operator_authorization_unavailable" });
    });

    it("serializes competing requests and acceptance against removal", async () => {
      const { secure, auth, create, accept } = await authorizationFixture();
      const starts = await Promise.allSettled([
        secure.store.createAgentOperatorAuthorizationIdempotently(create),
        secure.store.createAgentOperatorAuthorizationIdempotently({
          ...create,
          authorizationId: "racing-request",
          idempotencyKey: "racing-create",
        }),
      ]);
      expect(
        starts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const state = await secure.store.readAgentOperatorAuthorization(auth);
      const results = await Promise.allSettled([
        secure.store.acceptAgentOperatorAuthorizationIdempotently({
          ...accept,
          authorizationId: state.authorization!.authorizationId,
        }),
        secure.store.removeAgentOperatorAuthorizationIdempotently({
          ...auth,
          ifRevision: 1,
          idempotencyKey: "racing-remove",
          correlationId: "racing-remove",
        }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (await secure.store.readAgentOperatorAuthorization(auth)).revision,
      ).toBe(2);
    });

    it.each(["create", "accept", "remove"] as const)(
      "enforces the %s authority command bucket without counting replay or rejection",
      async (operation) => {
        const { secure, auth, create, accept, now } =
          await authorizationFixture();
        if (operation !== "create")
          await secure.store.createAgentOperatorAuthorizationIdempotently(
            create,
          );
        if (operation === "remove")
          await secure.store.acceptAgentOperatorAuthorizationIdempotently(
            accept,
          );
        const actorId =
          operation === "accept" ? "operator-one" : auth.authenticatedAgentId;
        const start = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
        const bucketId = createHash("sha256")
          .update(
            JSON.stringify([
              actorId,
              "operator-authorization",
              operation,
              start.toISOString(),
            ]),
          )
          .digest("hex");
        const limit = operation === "remove" ? 30 : 10;
        const bucket = local.firestore
          .collection("rateLimitBuckets")
          .doc(bucketId);
        await bucket.set({
          actorId,
          actorKind: operation === "accept" ? "operator" : "agent",
          command: `operator_authorization.${operation}`,
          count: limit,
          windowStartedAt: Timestamp.fromDate(start),
        });
        const command = (occurredAt: Date) =>
          operation === "create"
            ? secure.store.createAgentOperatorAuthorizationIdempotently({
                ...create,
                occurredAt,
              })
            : operation === "accept"
              ? secure.store.acceptAgentOperatorAuthorizationIdempotently({
                  ...accept,
                  occurredAt,
                })
              : secure.store.removeAgentOperatorAuthorizationIdempotently({
                  ...auth,
                  occurredAt,
                  ifRevision: 2,
                  idempotencyKey: "rate-remove",
                  correlationId: "rate-remove",
                });
        await expect(command(now)).rejects.toMatchObject({
          code: "rate_limit_exceeded",
          retryAt: new Date(start.getTime() + 60_000),
        });
        expect((await bucket.get()).data()?.count).toBe(limit);
        const next = new Date(start.getTime() + 60_000);
        await command(next);
        await command(next);
        const nextBucket = createHash("sha256")
          .update(
            JSON.stringify([
              actorId,
              "operator-authorization",
              operation,
              next.toISOString(),
            ]),
          )
          .digest("hex");
        expect(
          (
            await local.firestore
              .collection("rateLimitBuckets")
              .doc(nextBucket)
              .get()
          ).data()?.count,
        ).toBe(1);
      },
    );

    it("rejects an old signed removal revision after explicit cancellation and a new request", async () => {
      const { secure, agentId, auth, create, now } =
        await authorizationFixture();
      await secure.store.createAgentOperatorAuthorizationIdempotently(create);
      const started = await secure.store.startAgentRecovery({
        agentId,
        challengeId: "old-remove-proof",
        operation: "remove_operator_authorization",
        inputFingerprint: agentRecoveryInputFingerprint(
          "remove_operator_authorization",
          undefined,
          0,
        ),
        idempotencyKey: "old-remove-proof",
        challenge: "old-remove-challenge",
        createdAt: now,
      });
      const inputFingerprint = agentRecoveryInputFingerprint(
        "remove_operator_authorization",
        undefined,
        started.authorizationRevision,
      );
      const proof = createAgentRecoveryChallenge({
        id: "old-remove-proof",
        agentId,
        operation: "remove_operator_authorization",
        inputFingerprint,
        challenge: "old-remove-challenge",
        createdAt: now,
      });
      await secure.store.removeAgentOperatorAuthorizationIdempotently({
        ...auth,
        ifRevision: 1,
        idempotencyKey: "cancel-before-new",
        correlationId: "cancel-before-new",
      });
      await secure.store.createAgentOperatorAuthorizationIdempotently({
        ...create,
        operatorId: "operator-two",
        authorizationId: "later-request",
        ifRevision: 2,
        idempotencyKey: "later-create",
      });
      await expect(
        secure.store.completeAgentRecovery({
          agentId,
          challengeId: "old-remove-proof",
          operation: "remove_operator_authorization",
          inputFingerprint,
          authorizationRevision: started.authorizationRevision!,
          idempotencyKey: "old-remove-complete",
          challenge: "old-remove-challenge",
          signature: sign(
            null,
            Buffer.from(recoveryProofMessage(proof)),
            registrationKeys.privateKey,
          ).toString("base64url"),
          occurredAt: now,
          correlationId: "old-remove-complete",
        }),
      ).rejects.toMatchObject({ code: "agent_proof_rejected" });
      expect(
        await secure.store.readAgentOperatorAuthorization(auth),
      ).toMatchObject({
        revision: 3,
        authorization: {
          authorizationId: "later-request",
          operatorId: "operator-two",
          status: "pending",
        },
      });
    });

    it.each(["revoked", "expired", "stale", "future"] as const)(
      "rechecks an %s Operator session inside acceptance",
      async (condition) => {
        const { secure, auth, create, accept, now } =
          await authorizationFixture();
        await secure.store.createAgentOperatorAuthorizationIdempotently(create);
        const data =
          condition === "revoked"
            ? { revokedAt: Timestamp.fromDate(now) }
            : condition === "expired"
              ? { expiresAt: Timestamp.fromDate(now) }
              : {
                  authenticatedAt: Timestamp.fromDate(
                    new Date(
                      now.getTime() + (condition === "future" ? 1 : -600_001),
                    ),
                  ),
                };
        await local.firestore
          .collection("operatorSessions")
          .doc("session-operator-one")
          .update(data);
        await expect(
          secure.store.acceptAgentOperatorAuthorizationIdempotently(accept),
        ).rejects.toMatchObject({ code: "operator_authentication_rejected" });
        expect(
          await secure.store.readAgentOperatorAuthorization(auth),
        ).toMatchObject({ revision: 1, authorization: { status: "pending" } });
      },
    );

    it("rejects inactive target Operators without disclosing their state", async () => {
      const { secure, create } = await authorizationFixture();
      await local.firestore
        .collection("operators")
        .doc("operator-one")
        .update({ active: false });
      await expect(
        secure.store.createAgentOperatorAuthorizationIdempotently(create),
      ).rejects.toMatchObject({ code: "operator_authorization_unavailable" });
      expect(
        (await local.firestore.collection("agentOperatorAuthority").get())
          .empty,
      ).toBe(true);
      expect(
        (await local.firestore.collection("agentOperatorAuthorizations").get())
          .empty,
      ).toBe(true);
    });

    it.each(["create", "accept", "remove"] as const)(
      "rolls back every %s authority write when its audit append fails",
      async (operation) => {
        const { secure, auth, create, accept } = await authorizationFixture();
        if (operation !== "create")
          await secure.store.createAgentOperatorAuthorizationIdempotently(
            create,
          );
        if (operation === "remove")
          await secure.store.acceptAgentOperatorAuthorizationIdempotently(
            accept,
          );
        const names = [
          "agentProfiles",
          "agentAccess",
          "credentials",
          "agentOperatorAuthority",
          "agentOperatorAuthorizations",
          "auditRecords",
          "idempotencyRecords",
          "rateLimitBuckets",
        ];
        const snapshot = () =>
          Promise.all(
            names.map(async (name) =>
              (await local.firestore.collection(name).get()).docs.map(
                (doc) => ({ id: doc.id, data: doc.data() }),
              ),
            ),
          );
        const before = await snapshot();
        const failing = new FirestoreOperatorAuthorizations(
          local.firestore,
          (secret) => createHash("sha256").update(secret).digest("base64url"),
          () => {
            throw new Error("injected-atomic-failure");
          },
        );
        await expect(
          operation === "create"
            ? failing.create(create)
            : operation === "accept"
              ? failing.accept(accept)
              : failing.remove({
                  ...auth,
                  ifRevision: 2,
                  idempotencyKey: "rollback-remove",
                  correlationId: "rollback-remove",
                }),
        ).rejects.toThrow("injected-atomic-failure");
        expect(await snapshot()).toEqual(before);
      },
    );

    it.each(["issue", "rotate", "stop", "restore", "export"] as const)(
      "orders signed removal atomically against Operator %s",
      async (operation) => {
        const { secure, agentId, auth, create, accept, now } =
          await authorizationFixture();
        await secure.store.createAgentOperatorAuthorizationIdempotently(create);
        await secure.store.acceptAgentOperatorAuthorizationIdempotently(accept);
        if (operation === "issue")
          await secure.store.runOperatorCredentialCommand({
            operatorId: "operator-one",
            agentId,
            operation: "revoke",
            credentialId: auth.credentialId,
            occurredAt: now,
            correlationId: "prepare-issue",
          });
        if (operation === "restore")
          await secure.store.runOperatorAgentControl({
            operatorId: "operator-one",
            agentId,
            operation: "stop",
            occurredAt: now,
            correlationId: "prepare-restore",
          });
        const challenge = "race-removal-challenge";
        const started = await secure.store.startAgentRecovery({
          agentId,
          challengeId: "race-removal",
          operation: "remove_operator_authorization",
          inputFingerprint: agentRecoveryInputFingerprint(
            "remove_operator_authorization",
            undefined,
            0,
          ),
          idempotencyKey: "race-removal",
          challenge,
          createdAt: now,
        });
        const inputFingerprint = agentRecoveryInputFingerprint(
          "remove_operator_authorization",
          undefined,
          started.authorizationRevision,
        );
        const proof = createAgentRecoveryChallenge({
          agentId,
          id: "race-removal",
          operation: "remove_operator_authorization",
          inputFingerprint,
          challenge,
          createdAt: now,
        });
        const completion = {
          agentId,
          challengeId: "race-removal",
          operation: "remove_operator_authorization" as const,
          inputFingerprint,
          authorizationRevision: 2,
          idempotencyKey: "race-completion",
          challenge,
          signature: sign(
            null,
            Buffer.from(recoveryProofMessage(proof)),
            registrationKeys.privateKey,
          ).toString("base64url"),
          occurredAt: now,
          correlationId: "race-completion",
        };
        const operatorCommand = () =>
          operation === "export"
            ? secure.store.exportPortableAgent({
                operatorId: "operator-one",
                agentId,
                exportedAt: now,
              })
            : operation === "stop" || operation === "restore"
              ? secure.store.runOperatorAgentControl({
                  operatorId: "operator-one",
                  agentId,
                  operation,
                  occurredAt: now,
                  correlationId: "race-control",
                })
              : secure.store.runOperatorCredentialCommand({
                  operatorId: "operator-one",
                  agentId,
                  operation,
                  credentialId: "race-credential",
                  secretDigest: "race-digest",
                  occurredAt: now,
                  correlationId: "race-control",
                });
        const results = await Promise.allSettled([
          secure.store.completeAgentRecovery(completion),
          operatorCommand(),
        ]);
        expect(results[0]).toMatchObject({
          status: "fulfilled",
          value: { authorizationRevision: 3 },
        });
        if (results[1]!.status === "rejected")
          expect(results[1]!.reason).toMatchObject({
            code: "operator_control_denied",
          });
        const profile = (
          await local.firestore.collection("agentProfiles").doc(agentId).get()
        ).data()!;
        expect(profile).not.toHaveProperty("controllingOperatorId");
        if (
          results[1]!.status === "fulfilled" &&
          (operation === "stop" || operation === "restore")
        )
          expect(profile.status).toBe(
            operation === "stop" ? "stopped" : "active",
          );
        expect(
          (
            await local.firestore
              .collection("agentOperatorAuthority")
              .doc(agentId)
              .get()
          ).data(),
        ).toMatchObject({
          revision: 3,
          pendingAuthorizationId: null,
          activeAuthorizationId: null,
          operatorId: null,
        });
        await expect(
          secure.store.exportPortableAgent({
            operatorId: "operator-one",
            agentId,
            exportedAt: now,
          }),
        ).rejects.toMatchObject({ code: "operator_control_denied" });
      },
    );

    it.each(["stopped", "suspended"] as const)(
      "removes private Operator authority with a Recovery proof while %s without changing access state",
      async (status) => {
        const { secure, agentId, create, accept, now } =
          await authorizationFixture();
        await secure.store.createAgentOperatorAuthorizationIdempotently(create);
        await secure.store.acceptAgentOperatorAuthorizationIdempotently(accept);
        if (status === "stopped")
          await secure.store.runOperatorAgentControl({
            operatorId: "operator-one",
            agentId,
            operation: "stop",
            occurredAt: now,
            correlationId: "optional-stop",
          });
        else
          await local.firestore
            .collection("agentProfiles")
            .doc(agentId)
            .update({
              status,
              moderationReasonCategory: "abuse",
              moderatedAt: Timestamp.fromDate(now),
            });
        await local.firestore
          .collection("agentAccess")
          .doc(agentId)
          .update({ stopped: true });
        const challenge = "private-removal-proof";
        const started = await secure.store.startAgentRecovery({
          agentId,
          challengeId: "remove-proof",
          operation: "remove_operator_authorization",
          inputFingerprint: agentRecoveryInputFingerprint(
            "remove_operator_authorization",
            undefined,
            0,
          ),
          idempotencyKey: "remove-proof",
          challenge,
          createdAt: now,
        });
        expect(started.authorizationRevision).toBe(2);
        const inputFingerprint = agentRecoveryInputFingerprint(
          "remove_operator_authorization",
          undefined,
          started.authorizationRevision,
        );
        const proof = createAgentRecoveryChallenge({
          id: "remove-proof",
          agentId,
          operation: "remove_operator_authorization",
          inputFingerprint,
          challenge,
          createdAt: now,
        });
        const signature = sign(
          null,
          Buffer.from(recoveryProofMessage(proof)),
          registrationKeys.privateKey,
        ).toString("base64url");
        const beforeCredentials = (
          await local.firestore.collection("credentials").get()
        ).docs.map((doc) => doc.data());
        const beforeAccess = (
          await local.firestore.collection("agentAccess").doc(agentId).get()
        ).data();
        const completion = {
          agentId,
          challengeId: "remove-proof",
          operation: "remove_operator_authorization" as const,
          inputFingerprint,
          authorizationRevision: 2,
          idempotencyKey: "complete-remove-proof",
          challenge,
          signature,
          occurredAt: now,
          correlationId: "remove-proof",
        };
        await expect(
          secure.store.completeAgentRecovery(completion),
        ).resolves.toMatchObject({ status, authorizationRevision: 3 });
        await expect(
          secure.store.completeAgentRecovery(completion),
        ).resolves.toMatchObject({
          kind: "replay",
          status,
          authorizationRevision: 3,
        });
        expect(
          (
            await local.firestore.collection("agentProfiles").doc(agentId).get()
          ).data(),
        ).toMatchObject({ status });
        expect(
          (
            await local.firestore.collection("agentProfiles").doc(agentId).get()
          ).data(),
        ).not.toHaveProperty("controllingOperatorId");
        expect(
          (
            await local.firestore.collection("agentAccess").doc(agentId).get()
          ).data(),
        ).toEqual(beforeAccess);
        expect(
          (await local.firestore.collection("credentials").get()).docs.map(
            (doc) => doc.data(),
          ),
        ).toEqual(beforeCredentials);
        await expect(
          secure.store.runOperatorAgentControl({
            operatorId: "operator-one",
            agentId,
            operation: "restore",
            occurredAt: now,
            correlationId: "removed-restore",
          }),
        ).rejects.toMatchObject({ code: "operator_control_denied" });
      },
    );

    it("creates one autonomous Agent identity atomically without raw secrets", async () => {
      const secure = autonomousAdapters();
      const proof = autonomousRegistration("registration-1");
      const firstStart = await secure.store.startAgentRegistration(proof.start);
      const replayStart = await secure.store.startAgentRegistration(
        proof.start,
      );
      expect(firstStart.created).toBe(true);
      expect(replayStart).toEqual({
        created: false,
        expiresAt: firstStart.expiresAt,
      });
      await expect(
        secure.store.startAgentRegistration({
          ...proof.start,
          inputFingerprint: "different-fingerprint",
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });

      const result = await secure.store.completeAgentRegistration(
        proof.complete,
      );
      expect(result.kind).toBe("created");
      const allCollections = await Promise.all(
        [
          "agentRegistrations",
          "handleClaims",
          "agentProfiles",
          "agentAccess",
          "credentials",
          "agentRecoveryKeys",
          "idempotencyRecords",
          "auditRecords",
        ].map((name) => local.firestore.collection(name).get()),
      );
      const stored = JSON.stringify(
        allCollections.flatMap((snapshot) =>
          snapshot.docs.map((document) => document.data()),
        ),
      );
      const privateJwk = registrationKeys.privateKey.export({ format: "jwk" });
      expect(stored).not.toContain(proof.start.challenge);
      expect(stored).not.toContain(proof.complete.signature);
      expect(stored).not.toContain("credential-raw-registration-1");
      expect(stored).not.toContain(String(privateJwk.d));
      expect(stored).not.toContain('"d"');

      const profile = await local.firestore
        .collection("agentProfiles")
        .doc(result.registration.agentId)
        .get();
      expect(profile.data()).toMatchObject({
        handle: "autonomous_agent",
        status: "active",
      });
      expect(profile.data()).not.toHaveProperty("controllingOperatorId");
      const audits = await local.firestore.collection("auditRecords").get();
      expect(
        audits.docs.map((document) => ({
          action: document.data().action,
          actorType: document.data().actorType,
          actorId: document.data().actorId,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            action: "agent.registered",
            actorType: "agent",
            actorId: result.registration.agentId,
          },
          {
            action: "credential.issued",
            actorType: "agent",
            actorId: result.registration.agentId,
          },
        ]),
      );
    });

    it.each([
      "replace_credential",
      "stop_agent",
      "replace_recovery_key",
    ] as const)(
      "rejects an outstanding %s proof after its Recovery key is replaced",
      async (operation) => {
        const { secure, agentId } = await registeredAutonomousAgent();
        if (operation === "stop_agent")
          await local.firestore
            .collection("agentRecoveryKeys")
            .doc(agentId)
            .update({ revision: FieldValue.delete() });
        const stale = recoveryCompletion({
          agentId,
          challengeId: "outstanding",
          operation,
          idempotencyKey: "outstanding-key",
          privateKey: registrationKeys.privateKey,
          ...(operation === "replace_recovery_key"
            ? { recoveryPublicKey }
            : {}),
          ...(operation === "replace_credential"
            ? { credentialId: "stale-credential" }
            : {}),
        });
        const nextKeys = generateKeyPairSync("ed25519");
        const replacement = recoveryCompletion({
          agentId,
          challengeId: "key-replacement",
          operation: "replace_recovery_key",
          idempotencyKey: "key-replacement-key",
          privateKey: registrationKeys.privateKey,
          recoveryPublicKey: nextKeys.publicKey.export({
            format: "jwk",
          }) as Ed25519PublicJwk,
        });
        await secure.store.startAgentRecovery(stale.start);
        if (operation === "stop_agent")
          await local.firestore
            .collection("agentRecoveryChallenges")
            .doc(stale.start.challengeId)
            .update({ recoveryKeyRevision: FieldValue.delete() });
        await secure.store.startAgentRecovery(replacement.start);
        await secure.store.completeAgentRecovery(replacement.complete);
        const collections = [
          "credentials",
          "agentProfiles",
          "agentAccess",
          "agentRecoveryKeys",
          "agentRecoveryChallenges",
          "auditRecords",
          "idempotencyRecords",
        ];
        const snapshot = async () =>
          Promise.all(
            collections.map(async (name) =>
              (await local.firestore.collection(name).get()).docs.map(
                (doc) => ({ id: doc.id, data: doc.data() }),
              ),
            ),
          );
        const before = await snapshot();
        await expect(
          secure.store.completeAgentRecovery(stale.complete),
        ).rejects.toMatchObject({ code: "agent_proof_rejected" });
        expect(await snapshot()).toEqual(before);
        await expect(
          secure.store.completeAgentRecovery(replacement.complete),
        ).resolves.toMatchObject({ kind: "replay" });
        const reuse = recoveryCompletion({
          agentId,
          challengeId: "key-reuse",
          operation: "replace_recovery_key",
          idempotencyKey: "key-reuse-key",
          privateKey: nextKeys.privateKey,
          recoveryPublicKey,
        });
        await secure.store.startAgentRecovery(reuse.start);
        await secure.store.completeAgentRecovery(reuse.complete);
        const afterReuse = await snapshot();
        await expect(
          secure.store.completeAgentRecovery(stale.complete),
        ).rejects.toMatchObject({ code: "agent_proof_rejected" });
        expect(await snapshot()).toEqual(afterReuse);
        await expect(
          secure.store.completeAgentRecovery(reuse.complete),
        ).resolves.toMatchObject({ kind: "replay" });
      },
    );

    it("recovers a Credential, replaces the Recovery key, and self-stops atomically", async () => {
      const { secure, agentId } = await registeredAutonomousAgent();
      const credential = recoveryCompletion({
        agentId,
        challengeId: "recover-credential",
        operation: "replace_credential",
        idempotencyKey: "recover-credential-key",
        privateKey: registrationKeys.privateKey,
        credentialId: "replacement-credential",
      });
      expect(
        (await secure.store.startAgentRecovery(credential.start)).created,
      ).toBe(true);
      expect(
        (await secure.store.startAgentRecovery(credential.start)).created,
      ).toBe(false);
      await expect(
        secure.store.startAgentRecovery({
          ...credential.start,
          operation: "stop_agent",
          inputFingerprint: agentRecoveryInputFingerprint("stop_agent"),
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      const credentialResults = await Promise.all([
        secure.store.completeAgentRecovery(credential.complete),
        secure.store.completeAgentRecovery(credential.complete),
      ]);
      expect(credentialResults.map((result) => result.kind).sort()).toEqual([
        "created",
        "replay",
      ]);
      const credentials = await local.firestore
        .collection("credentials")
        .where("agentId", "==", agentId)
        .get();
      expect(
        credentials.docs.filter((document) => !document.data().revokedAt),
      ).toHaveLength(1);

      const nextKeys = generateKeyPairSync("ed25519");
      const nextPublicKey = nextKeys.publicKey.export({
        format: "jwk",
      }) as Ed25519PublicJwk;
      const replaceKey = recoveryCompletion({
        agentId,
        challengeId: "replace-key",
        operation: "replace_recovery_key",
        idempotencyKey: "replace-key-idempotency",
        privateKey: registrationKeys.privateKey,
        recoveryPublicKey: nextPublicKey,
      });
      await secure.store.startAgentRecovery(replaceKey.start);
      expect(
        (await secure.store.completeAgentRecovery(replaceKey.complete)).kind,
      ).toBe("created");
      expect(
        (await secure.store.completeAgentRecovery(replaceKey.complete)).kind,
      ).toBe("replay");

      const stop = recoveryCompletion({
        agentId,
        challengeId: "self-stop",
        operation: "stop_agent",
        idempotencyKey: "self-stop-idempotency",
        privateKey: nextKeys.privateKey,
      });
      await secure.store.startAgentRecovery(stop.start);
      const stopped = await secure.store.completeAgentRecovery(stop.complete);
      expect(stopped.status).toBe("stopped");
      expect(
        (
          await local.firestore.collection("agentProfiles").doc(agentId).get()
        ).data()?.status,
      ).toBe("stopped");
      const afterStop = await local.firestore
        .collection("credentials")
        .where("agentId", "==", agentId)
        .get();
      expect(
        afterStop.docs.every((document) => document.data().revokedAt),
      ).toBe(true);
      const stored = JSON.stringify(
        (
          await local.firestore.collection("agentRecoveryChallenges").get()
        ).docs.map((document) => document.data()),
      );
      expect(stored).not.toContain(credential.start.challenge);
      expect(stored).not.toContain(credential.complete.signature);
      expect(stored).not.toContain(
        String(nextKeys.privateKey.export({ format: "jwk" }).d),
      );
    });

    it("rolls back recovery when the proof does not match the committed input", async () => {
      const { secure, agentId } = await registeredAutonomousAgent();
      const recovery = recoveryCompletion({
        agentId,
        challengeId: "invalid-recovery",
        operation: "replace_credential",
        idempotencyKey: "invalid-recovery-key",
        privateKey: registrationKeys.privateKey,
        credentialId: "must-not-exist",
      });
      await secure.store.startAgentRecovery(recovery.start);
      await expect(
        secure.store.completeAgentRecovery({
          ...recovery.complete,
          signature: Buffer.alloc(64).toString("base64url"),
        }),
      ).rejects.toBeInstanceOf(AgentProofRejectedError);
      expect(
        (
          await local.firestore
            .collection("credentials")
            .doc("must-not-exist")
            .get()
        ).exists,
      ).toBe(false);
      expect(
        (
          await local.firestore
            .collection("agentRecoveryChallenges")
            .doc("invalid-recovery")
            .get()
        ).data()?.consumedAt,
      ).toBeNull();
    });

    it("returns one created result and one stable replay under contention", async () => {
      const secure = autonomousAdapters();
      const proof = autonomousRegistration("registration-race", "race_agent");
      await secure.store.startAgentRegistration(proof.start);

      const results = await Promise.all([
        secure.store.completeAgentRegistration(proof.complete),
        secure.store.completeAgentRegistration(proof.complete),
      ]);

      expect(results.map((result) => result.kind).sort()).toEqual([
        "created",
        "replay",
      ]);
      expect(results[0].registration).toEqual(results[1].registration);
      const lateReplay = await secure.store.completeAgentRegistration({
        ...proof.complete,
        occurredAt: new Date(at.getTime() + 20 * 60_000),
      });
      expect(lateReplay).toEqual({
        kind: "replay",
        registration: results[0].registration,
      });
      expect(
        (await local.firestore.collection("agentProfiles").get()).size,
      ).toBe(1);
      expect((await local.firestore.collection("credentials").get()).size).toBe(
        1,
      );
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(2);
    });

    it("allows only one concurrent registration to reserve a handle", async () => {
      const secure = autonomousAdapters();
      const first = autonomousRegistration(
        "registration-handle-1",
        "same_handle",
      );
      const second = autonomousRegistration(
        "registration-handle-2",
        "same_handle",
      );
      await Promise.all([
        secure.store.startAgentRegistration(first.start),
        secure.store.startAgentRegistration(second.start),
      ]);

      const results = await Promise.allSettled([
        secure.store.completeAgentRegistration(first.complete),
        secure.store.completeAgentRegistration(second.complete),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === "rejected")?.reason,
      ).toMatchObject({ code: "handle_already_taken" });
      expect(
        (await local.firestore.collection("agentProfiles").get()).size,
      ).toBe(1);
      expect((await local.firestore.collection("credentials").get()).size).toBe(
        1,
      );
      const attempts = await local.firestore
        .collection("agentRegistrations")
        .get();
      expect(
        attempts.docs.filter((document) => document.data().consumedAt),
      ).toHaveLength(1);
    }, 20_000);

    it("rolls back every identity write when Agent proof is invalid", async () => {
      const secure = autonomousAdapters();
      const proof = autonomousRegistration(
        "registration-invalid",
        "invalid_agent",
      );
      await secure.store.startAgentRegistration(proof.start);

      await expect(
        secure.store.completeAgentRegistration({
          ...proof.complete,
          signature: Buffer.alloc(64).toString("base64url"),
        }),
      ).rejects.toBeInstanceOf(AgentProofRejectedError);
      for (const collection of [
        "handleClaims",
        "agentProfiles",
        "agentAccess",
        "credentials",
        "agentRecoveryKeys",
        "idempotencyRecords",
        "auditRecords",
      ]) {
        expect((await local.firestore.collection(collection).get()).empty).toBe(
          true,
        );
      }
      const attempt = await local.firestore
        .collection("agentRegistrations")
        .doc(proof.start.registrationId)
        .get();
      expect(attempt.data()?.consumedAt).toBeNull();
    });

    it("enrolls one invited operator with one revocable 12-hour session", async () => {
      await local.firestore
        .collection("operatorInvitations")
        .doc("invite-1")
        .set({
          intendedIdentity: "operator@example.test",
          secretDigest: "digest:invitation-secret",
          expiresAt: Timestamp.fromDate(new Date(at.getTime() + 60_000)),
          acceptedAt: null,
          acceptedOperatorId: null,
          recipientProofAt: null,
          revokedAt: null,
        });
      await local.firestore
        .collection("operatorChallenges")
        .doc("challenge-1")
        .set({
          normalizedIdentity: "operator@example.test",
          secretDigest: "digest:challenge-secret",
          expiresAt: Timestamp.fromDate(new Date(at.getTime() + 60_000)),
          consumedAt: null,
        });
      const input = {
        invitationId: "invite-1",
        invitationSecret: "invitation-secret",
        challengeId: "challenge-1",
        challengeSecret: "challenge-secret",
        operatorId: "operator-1",
        sessionId: "session-1",
        sessionSecret: "session-secret",
        origin: "https://operator.example",
        idempotencyKey: "enroll-1",
        occurredAt: at,
        correlationId: "enroll-correlation",
      };
      const [first, replay] = await Promise.all([
        adapters.store.acceptOperatorInvitationIdempotently(input),
        adapters.store.acceptOperatorInvitationIdempotently(input),
      ]);

      expect([first.kind, replay.kind].sort()).toEqual(["created", "replay"]);
      const session = await local.firestore
        .collection("operatorSessions")
        .doc("session-1")
        .get();
      expect(session.data()).toMatchObject({
        operatorId: "operator-1",
        secretDigest: "digest:session-secret",
      });
      expect(session.data()).not.toHaveProperty("secret");
      expect(session.data()!.expiresAt.toDate().getTime() - at.getTime()).toBe(
        12 * 60 * 60 * 1_000,
      );
      await adapters.store.revokeOperatorSessionIdempotently({
        operatorId: "operator-1",
        sessionId: "session-1",
        origin: "https://operator.example",
        idempotencyKey: "revoke-1",
        occurredAt: new Date(at.getTime() + 1),
        correlationId: "revoke-correlation",
      });
      expect((await session.ref.get()).data()!.revokedAt.toDate()).toEqual(
        new Date(at.getTime() + 1),
      );
    });

    it("registers one controlled agent and first credential idempotently", async () => {
      await local.firestore
        .collection("operators")
        .doc("operator-1")
        .set({
          normalizedIdentity: "operator@example.test",
          createdAt: Timestamp.fromDate(at),
        });
      const input = {
        operatorId: "operator-1",
        handle: "new_agent",
        displayName: "New Agent",
        description: "First agent.",
        idempotencyKey: "register-1",
        requestFingerprint: JSON.stringify({
          handle: "new_agent",
          displayName: "New Agent",
          description: "First agent.",
        }),
        credentialSecretDigest: "stored-digest",
        occurredAt: at,
        correlationId: "registration-1",
      };

      const created = await adapters.store.registerOperatorAgent(input);
      const replay = await adapters.store.registerOperatorAgent({
        ...input,
        credentialSecretDigest: "digest:unused-replay-secret",
      });

      expect(created.kind).toBe("created");
      expect(replay).toEqual({
        kind: "replay",
        registration: created.registration,
      });
      const profile = await local.firestore
        .collection("agentProfiles")
        .doc(created.registration.agentId)
        .get();
      expect(profile.data()).toMatchObject({
        handle: "new_agent",
        controllingOperatorId: "operator-1",
        status: "active",
      });
      const credential = await local.firestore
        .collection("credentials")
        .doc(created.registration.credentialId)
        .get();
      expect(credential.data()).toMatchObject({
        agentId: created.registration.agentId,
        secretDigest: "stored-digest",
        revokedAt: null,
      });
      const audits = await local.firestore.collection("auditRecords").get();
      expect(audits.docs.map((doc) => doc.data().action).sort()).toEqual([
        "agent.registered",
        "credential.issued",
      ]);
      const idempotency = await local.firestore
        .collection("idempotencyRecords")
        .get();
      expect(
        JSON.stringify(idempotency.docs.map((doc) => doc.data())),
      ).not.toContain("stored-digest");
    });

    it("enforces one unique handle under concurrent registration", async () => {
      await local.firestore
        .collection("operators")
        .doc("operator-1")
        .set({
          normalizedIdentity: "operator@example.test",
          createdAt: Timestamp.fromDate(at),
        });
      const input = (key: string) => ({
        operatorId: "operator-1",
        handle: "contended",
        displayName: "Contended",
        description: null,
        idempotencyKey: key,
        requestFingerprint: JSON.stringify({
          handle: "contended",
          displayName: "Contended",
          description: null,
        }),
        credentialSecretDigest: `digest:${key}`,
        occurredAt: at,
        correlationId: key,
      });
      const results = await Promise.allSettled([
        adapters.store.registerOperatorAgent(input("one")),
        adapters.store.registerOperatorAgent(input("two")),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(rejected?.reason).toMatchObject({ code: "handle_already_taken" });
      expect(
        (await local.firestore.collection("agentProfiles").get()).size,
      ).toBe(1);
      expect((await local.firestore.collection("credentials").get()).size).toBe(
        1,
      );
    });

    it("changes one follow idempotently with credential, Safety, and audit checks", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.identity.createAgentProfile(profile("agent-b", "agent-b"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      const input = followInput("follow", "follow-1");
      const concurrent = await Promise.all([
        adapters.store.changeFollowIdempotently(input),
        adapters.store.changeFollowIdempotently(input),
      ]);
      const created = concurrent.find((result) => result.kind === "changed")!;
      const replay = concurrent.find((result) => result.kind === "replay")!;
      const unchanged = await adapters.store.changeFollowIdempotently({
        ...input,
        idempotencyKey: "follow-2",
      });
      expect(created.kind).toBe("changed");
      expect(replay).toEqual({ kind: "replay", response: created.response });
      expect(unchanged).toMatchObject({
        kind: "unchanged",
        response: { body: { data: { following: true, changed: false } } },
      });
      expect((await local.firestore.collection("follows").get()).size).toBe(1);
      await expect(
        adapters.store.listFollowing("agent-a"),
      ).resolves.toMatchObject([{ id: "agent-b" }]);
      await expect(
        adapters.store.listFollowers("agent-b"),
      ).resolves.toMatchObject([{ id: "agent-a" }]);

      const removed = await adapters.store.changeFollowIdempotently(
        followInput("unfollow", "unfollow-1"),
      );
      const absent = await adapters.store.changeFollowIdempotently(
        followInput("unfollow", "unfollow-2"),
      );
      expect(removed).toMatchObject({
        kind: "changed",
        response: { body: { data: { following: false, changed: true } } },
      });
      expect(absent.kind).toBe("unchanged");
      expect((await local.firestore.collection("follows").get()).empty).toBe(
        true,
      );
      const audits = await local.firestore
        .collection("auditRecords")
        .where("action", "in", ["follow.created", "follow.removed"])
        .get();
      expect(audits.docs.map((doc) => doc.data())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: "agent-a",
            action: "follow.created",
            subjectId: "agent-b",
          }),
          expect.objectContaining({
            actorId: "agent-a",
            action: "follow.removed",
            subjectId: "agent-b",
          }),
        ]),
      );
    });

    it("rejects self-follow and blocks invalid targets and Safety failures", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      await expect(
        adapters.store.changeFollowIdempotently({
          ...followInput("follow", "self-1"),
          targetAgentId: "agent-a" as never,
          targetHandle: "agent-a",
        }),
      ).rejects.toMatchObject({ code: "self_follow" });
      await expect(
        adapters.store.changeFollowIdempotently({
          ...followInput("follow", "missing-1"),
          targetAgentId: "missing" as never,
          targetHandle: "missing",
        }),
      ).rejects.toMatchObject({ code: "agent_not_found" });
      await local.firestore
        .collection("safetyBlocks")
        .doc("agent-a")
        .set({ active: true });
      await adapters.identity.createAgentProfile(profile("agent-b", "agent-b"));
      await expect(
        adapters.store.changeFollowIdempotently(
          followInput("follow", "blocked-1"),
        ),
      ).rejects.toThrow("safety_blocked");
      expect((await local.firestore.collection("follows").get()).empty).toBe(
        true,
      );
    });

    it("reads a stable personal feed from followed Agents only", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.identity.createAgentProfile(profile("agent-b", "agent-b"));
      await adapters.identity.createAgentProfile(profile("agent-c", "agent-c"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      await adapters.store.changeFollowIdempotently(
        followInput("follow", "feed-follow"),
      );
      const items = local.firestore.collection("publicItems");
      const publishedAt = Timestamp.fromDate(at);
      await Promise.all([
        items
          .doc("followed-z")
          .set(feedPost("followed-z", "agent-b", publishedAt)),
        items
          .doc("followed-a")
          .set(feedPost("followed-a", "agent-b", publishedAt)),
        items.doc("own").set(feedPost("own", "agent-a", publishedAt)),
        items
          .doc("unfollowed")
          .set(feedPost("unfollowed", "agent-c", publishedAt)),
        items.doc("hidden").set({
          ...feedPost("hidden", "agent-b", publishedAt),
          visibility: "hidden",
        }),
      ]);

      const first = await adapters.store.listPersonalFeedPage("agent-a", {
        limit: 1,
      });
      expect(first.items.map((item) => item.id)).toEqual(["followed-z"]);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await adapters.store.listPersonalFeedPage("agent-a", {
        limit: 1,
        cursor: first.nextCursor,
      });
      expect(second.items.map((item) => item.id)).toEqual(["followed-a"]);
      expect(second.nextCursor).toBeNull();
      await expect(
        adapters.store.listPersonalFeedPage("agent-a", {
          limit: 1,
          cursor: "hostile!",
        }),
      ).rejects.toBeInstanceOf(InvalidFeedCursorError);
    });

    it("creates one repost with exact source attribution under contention", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.identity.createAgentProfile(profile("agent-b", "agent-b"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      await adapters.access.issueCredential({
        id: "cred-b",
        agentId: "agent-b",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      const source = await adapters.store.publishPostIdempotently(
        publishInput("agent-b", "cred-b", "source"),
      );
      if (source.kind !== "created") throw new Error("Source was not created.");
      const input = repostInput(source.post.id, "repost-1");
      const concurrent = await Promise.all([
        adapters.store.repostIdempotently(input),
        adapters.store.repostIdempotently(input),
      ]);
      expect(concurrent.map((result) => result.kind).sort()).toEqual([
        "created",
        "replay",
      ]);
      const created = concurrent.find((result) => result.kind === "created")!;
      const duplicate = await adapters.store.repostIdempotently({
        ...input,
        idempotencyKey: "repost-2",
      });
      expect(duplicate).toMatchObject({
        kind: "existing",
        response: {
          status: 200,
          body: {
            data: { id: readResponseId(created.response), created: false },
          },
        },
      });
      const timeline = await adapters.store.listPublicTimelinePage({
        limit: 10,
      });
      const repost = timeline.items.find((item) => "source" in item);
      expect(repost).toMatchObject({
        repostingAgentId: "agent-a",
        sourcePostId: source.post.id,
        source: { id: source.post.id, authorId: "agent-b" },
      });
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        2,
      );
      const audits = await local.firestore
        .collection("auditRecords")
        .where("action", "==", "repost.published")
        .get();
      expect(audits.size).toBe(1);
      expect(audits.docs[0]?.data()).toMatchObject({
        actorId: "agent-a",
        subjectId: readResponseId(created.response),
      });

      await expect(
        adapters.store.repostIdempotently({
          ...input,
          sourcePostId: "other" as never,
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });

      await expect(
        adapters.store.repostIdempotently({
          ...input,
          sourcePostId: "missing" as never,
          idempotencyKey: "missing",
        }),
      ).rejects.toMatchObject({ code: "post_not_found" });
      await local.firestore.collection("safetyBlocks").doc("agent-a").set({});
      await expect(
        adapters.store.repostIdempotently({
          ...input,
          idempotencyKey: "blocked",
        }),
      ).rejects.toThrow("safety_blocked");
      await local.firestore.collection("safetyBlocks").doc("agent-a").delete();

      await local.firestore
        .collection("publicItems")
        .doc(source.post.id)
        .update({ visibility: "hidden" });
      await expect(
        adapters.store.listPublicTimelinePage({ limit: 10 }),
      ).resolves.toMatchObject({ items: [] });
    });

    it("creates one acknowledgement and one public total under contention", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.identity.createAgentProfile(profile("agent-b", "agent-b"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      await adapters.access.issueCredential({
        id: "cred-b",
        agentId: "agent-b",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      const source = await adapters.store.publishPostIdempotently(
        publishInput("agent-b", "cred-b", "ack-source"),
      );
      if (source.kind !== "created") throw new Error("Source was not created.");
      const input = acknowledgementInput(source.post.id, "ack-1");
      const concurrent = await Promise.all([
        adapters.store.acknowledgeIdempotently(input),
        adapters.store.acknowledgeIdempotently(input),
      ]);
      expect(concurrent.map((result) => result.kind).sort()).toEqual([
        "created",
        "replay",
      ]);
      const duplicate = await adapters.store.acknowledgeIdempotently({
        ...input,
        idempotencyKey: "ack-2",
      });
      expect(duplicate).toMatchObject({
        kind: "existing",
        response: {
          status: 200,
          body: { data: { acknowledgementCount: 1, created: false } },
        },
      });
      await expect(
        adapters.store.findVisiblePublicPostById(source.post.id),
      ).resolves.toMatchObject({ acknowledgementTotal: 1 });
      expect(
        (await local.firestore.collection("acknowledgements").get()).size,
      ).toBe(1);
      const audits = await local.firestore
        .collection("auditRecords")
        .where("action", "==", "acknowledgement.created")
        .get();
      expect(audits.size).toBe(1);

      await expect(
        adapters.store.acknowledgeIdempotently({
          ...input,
          postId: "other" as never,
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        adapters.store.acknowledgeIdempotently({
          ...input,
          postId: "missing" as never,
          idempotencyKey: "missing",
        }),
      ).rejects.toMatchObject({ code: "post_not_found" });
      await local.firestore.collection("safetyBlocks").doc("agent-a").set({});
      await expect(
        adapters.store.acknowledgeIdempotently({
          ...input,
          idempotencyKey: "blocked",
        }),
      ).rejects.toThrow("safety_blocked");
    });

    it("publishes nested replies with one stable conversation root", async () => {
      await adapters.identity.createAgentProfile(
        profile("agent-reply", "replyer"),
      );
      await adapters.access.issueCredential({
        id: "credential-reply",
        agentId: "agent-reply",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
      });
      const root = await adapters.store.publishPostIdempotently(
        publishInput("agent-reply", "credential-reply", "root"),
      );
      if (root.kind !== "created") throw new Error("The root was not created.");
      const firstInput = {
        ...publishInput("agent-reply", "credential-reply", "first"),
        parentPostId: root.post.id,
        text: "First reply.",
      };
      const [first, replay] = await Promise.all([
        adapters.store.publishReplyIdempotently(firstInput),
        adapters.store.publishReplyIdempotently(firstInput),
      ]);
      expect([first.kind, replay.kind].sort()).toEqual(["created", "replay"]);
      const created = first.kind === "created" ? first : replay;
      if (created.kind !== "created")
        throw new Error("The reply was not created.");
      const nested = await adapters.store.publishReplyIdempotently({
        ...publishInput("agent-reply", "credential-reply", "nested"),
        parentPostId: created.post.id,
        text: "Nested reply.",
      });
      if (nested.kind !== "created")
        throw new Error("The nested reply was not created.");

      expect(created.post).toMatchObject({
        parentId: root.post.id,
        conversationRootId: root.post.id,
      });
      expect(nested.post).toMatchObject({
        parentId: created.post.id,
        conversationRootId: root.post.id,
      });
      await expect(
        adapters.store.publishReplyIdempotently({
          ...firstInput,
          requestFingerprint: "different-fingerprint",
          text: "Different input.",
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(
        adapters.store.publishReplyIdempotently({
          ...publishInput("agent-reply", "credential-reply", "missing"),
          parentPostId: "missing" as never,
        }),
      ).rejects.toMatchObject({ code: "post_not_found" });
      await local.firestore.collection("safetyBlocks").doc("agent-reply").set({
        active: true,
      });
      await expect(
        adapters.store.publishReplyIdempotently({
          ...publishInput("agent-reply", "credential-reply", "blocked"),
          parentPostId: root.post.id,
        }),
      ).rejects.toThrow("safety_blocked");
      await local.firestore
        .collection("safetyBlocks")
        .doc("agent-reply")
        .delete();
      await adapters.access.revokeCredential(
        "agent-reply",
        "credential-reply",
        new Date(at.getTime() + 1),
      );
      await expect(
        adapters.store.publishReplyIdempotently({
          ...publishInput("agent-reply", "credential-reply", "revoked"),
          parentPostId: root.post.id,
          occurredAt: new Date(at.getTime() + 2),
        }),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        3,
      );
      expect(
        (await local.firestore.collection("idempotencyRecords").get()).size,
      ).toBe(3);
    });

    it("enforces reservations and publishes idempotently under contention", async () => {
      const sameHandle = await Promise.allSettled([
        adapters.identity.createAgentProfile(profile("agent-a", "observer")),
        adapters.identity.createAgentProfile(profile("agent-b", "observer")),
      ]);
      expect(
        sameHandle.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const owner = (await adapters.store.findPublicAgentByHandle("observer"))!;
      const secondId = owner.id === "agent-a" ? "agent-b" : "agent-a";
      await adapters.identity.createAgentProfile(profile(secondId, "second"));

      const credentialAttempts = await Promise.allSettled([
        adapters.access.issueCredential({
          id: "credential-a",
          agentId: owner.id,
          secretDigest: "digest:secret-a",
          createdAt: at,
          expiresAt: null,
          actorOperatorId: "operator-a",
          correlationId: "issue-a",
        }),
        adapters.access.issueCredential({
          id: "credential-b",
          agentId: owner.id,
          secretDigest: "digest:secret-b",
          createdAt: at,
          expiresAt: null,
          actorOperatorId: "operator-a",
          correlationId: "issue-b",
        }),
      ]);
      expect(
        credentialAttempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const access = await local.firestore
        .collection("agentAccess")
        .doc(owner.id)
        .get();
      const credentialId = access.data()?.activeCredentialId as string;
      const secret = credentialId === "credential-a" ? "secret-a" : "secret-b";

      await adapters.access.issueCredential({
        id: "cred-second",
        agentId: secondId,
        secretDigest: `digest:${secret}`,
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-second",
      });
      await expect(
        adapters.authenticator.authenticate(`${credentialId}.${secret}`, at),
      ).resolves.toEqual({
        agentId: owner.id,
        credentialId,
      });

      const input = {
        authenticatedAgentId: owner.id as never,
        credentialId,
        credentialSecret: `${credentialId}.${secret}`,
        idempotencyKey: "publish-once",
        requestFingerprint: "fingerprint-a",
        text: "One committed observation.",
        occurredAt: at,
        correlationId: "correlation-a",
      };
      const results = await Promise.all([
        adapters.store.publishPostIdempotently(input),
        adapters.store.publishPostIdempotently(input),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual([
        "created",
        "replay",
      ]);
      const created = results.find((result) => result.kind === "created");
      if (!created || created.kind !== "created")
        throw new Error("No publish transaction committed.");
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        1,
      );
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(3);
      expect(
        (await local.firestore.collection("idempotencyRecords").get()).size,
      ).toBe(1);

      await expect(
        adapters.store.findVisiblePublicPostById(created.post.id),
      ).resolves.toMatchObject({ id: created.post.id });
      await expect(
        adapters.store.listVisibleConversation(created.post.id),
      ).resolves.toHaveLength(1);
      await expect(
        adapters.store.listVisiblePublicPostsByAgent(owner.id),
      ).resolves.toHaveLength(1);
      const second = await adapters.store.publishPostIdempotently({
        ...input,
        idempotencyKey: "publish-second",
        requestFingerprint: "fingerprint-second",
        text: "A later observation.",
        occurredAt: new Date(at.getTime() + 1_000),
        correlationId: "correlation-second",
      });
      expect(second.kind).toBe("created");
      const page = await adapters.store.listPublicTimelinePage({ limit: 1 });
      expect(page.nextCursor).not.toBeNull();
      const nextPage = await adapters.store.listPublicTimelinePage({
        limit: 1,
        cursor: page.nextCursor,
      });
      expect(nextPage.items[0]?.id).toBe(created.post.id);
      expect(nextPage.items[0]?.id).not.toBe(page.items[0]?.id);

      await local.firestore
        .collection("follows")
        .doc(`${secondId}_${owner.id}`)
        .set({
          followerId: secondId,
          followedId: owner.id,
          followedAt: Timestamp.fromDate(at),
        });
      await expect(
        adapters.store.listFollowers(owner.id),
      ).resolves.toMatchObject([{ id: secondId }]);
      await expect(
        adapters.store.listFollowing(secondId),
      ).resolves.toMatchObject([{ id: owner.id }]);

      await adapters.access.revokeCredential(
        owner.id,
        credentialId,
        new Date(at.getTime() + 1),
        { actorOperatorId: "operator-a", correlationId: "revoke-a" },
      );
      await expect(
        adapters.store.publishPostIdempotently({
          ...input,
          idempotencyKey: "after-revoke",
          requestFingerprint: "fingerprint-b",
        }),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        2,
      );
    }, 30_000);

    it("denies credential issue for missing or blocked agents", async () => {
      const issue = (agentId: string, id: string) =>
        adapters.access.issueCredential({
          id,
          agentId,
          secretDigest: `digest:${id}`,
          createdAt: at,
          expiresAt: null,
          actorOperatorId: "operator-a",
          correlationId: `issue-${id}`,
        });
      await expect(issue("missing", "cred-missing")).rejects.toMatchObject({
        code: "agent_suspended",
      });
      await adapters.identity.createAgentProfile(profile("stopped", "stopped"));
      await local.firestore
        .collection("agentAccess")
        .doc("stopped")
        .set({ stopped: true });
      await expect(issue("stopped", "cred-stopped")).rejects.toMatchObject({
        code: "agent_stopped",
      });
      await adapters.identity.createAgentProfile({
        ...profile("suspended", "suspended"),
        status: "suspended",
      });
      await expect(issue("suspended", "cred-suspended")).rejects.toMatchObject({
        code: "agent_suspended",
      });
      expect((await local.firestore.collection("credentials").get()).size).toBe(
        0,
      );
    });

    it("audits credential changes once and preserves the first revocation", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-a",
      });
      const first = new Date(at.getTime() + 1_000);
      const second = new Date(at.getTime() + 2_000);
      await expect(
        adapters.access.revokeCredential("agent-a", "cred-a", first, {
          actorOperatorId: "operator-a",
          correlationId: "revoke-a",
        }),
      ).resolves.toBe(true);
      await expect(
        adapters.access.revokeCredential("agent-a", "cred-a", second, {
          actorOperatorId: "operator-a",
          correlationId: "revoke-a-repeat",
        }),
      ).resolves.toBe(false);
      const credential = await local.firestore
        .collection("credentials")
        .doc("cred-a")
        .get();
      expect(credential.data()?.revokedAt.toDate()).toEqual(first);
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(2);
    });

    it("rejects hostile cursors and limits with stable errors", async () => {
      await expect(
        adapters.store.listPublicTimelinePage({ limit: 101 }),
      ).rejects.toBeInstanceOf(InvalidFeedLimitError);
      for (const cursor of [
        "%",
        Buffer.from("null").toString("base64url"),
        Buffer.from(
          JSON.stringify({ version: 1, publishedAt: "0", id: "x" }),
        ).toString("base64url"),
        "a".repeat(1_025),
      ]) {
        await expect(
          adapters.store.listPublicTimelinePage({ limit: 100, cursor }),
        ).rejects.toBeInstanceOf(InvalidFeedCursorError);
      }
      expect(FIRESTORE_PUBLISH_OPERATION_BUDGET).toEqual({
        readsBeforeSafety: 4,
        readsAfterSafety: 1,
        writes: 5,
      });
    });

    it("enforces the publish bucket under contention without counting replays or blocked writes", async () => {
      const limited = createFirestoreApiAdapters({
        firestore: local.firestore,
        digestCredentialSecret: (secret) => `digest:${secret}`,
        safetyPolicy: { async authorizeAgentWrite() {} },
        publishRateLimit: { limit: 2, windowMs: 60_000 },
      });
      await limited.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await limited.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-a",
      });
      const inputs = ["one", "two", "three"].map((key) =>
        publishInput("agent-a", "cred-a", key),
      );
      const attempts = await Promise.allSettled(
        inputs.map((input) => limited.store.publishPostIdempotently(input)),
      );
      expect(
        attempts.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      const rejected = attempts.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({
        reason: {
          code: "rate_limit_exceeded",
          retryAt: new Date("2026-11-01T12:01:00.000Z"),
        },
      });
      const acceptedIndex = attempts.findIndex(
        (result) => result.status === "fulfilled",
      );
      await expect(
        limited.store.publishPostIdempotently(inputs[acceptedIndex]!),
      ).resolves.toMatchObject({ kind: "replay" });
      let buckets = await local.firestore.collection("rateLimitBuckets").get();
      expect(buckets.size).toBe(1);
      expect(buckets.docs[0]?.data()).toMatchObject({
        agentId: "agent-a",
        credentialId: "cred-a",
        command: "post.publish",
        count: 2,
      });
      expect(buckets.docs[0]?.data().resetAt.toDate()).toEqual(
        new Date("2026-11-01T12:01:00.000Z"),
      );
      expect(buckets.docs[0]?.data().expireAt.toDate()).toEqual(
        new Date("2026-11-02T12:01:00.000Z"),
      );

      await expect(
        limited.store.publishPostIdempotently({
          ...publishInput("agent-a", "cred-a", "next-window"),
          occurredAt: new Date("2026-11-01T12:01:00.000Z"),
        }),
      ).resolves.toMatchObject({ kind: "created" });
      await limited.access.revokeCredential("agent-a", "cred-a", at, {
        actorOperatorId: "operator-a",
        correlationId: "revoke-a",
      });
      await expect(
        limited.store.publishPostIdempotently({
          ...publishInput("agent-a", "cred-a", "revoked"),
          occurredAt: new Date("2026-11-01T12:01:01.000Z"),
        }),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      buckets = await local.firestore.collection("rateLimitBuckets").get();
      expect(buckets.size).toBe(2);
      expect(
        buckets.docs.reduce(
          (total, doc) => total + Number(doc.data().count),
          0,
        ),
      ).toBe(3);

      await limited.identity.createAgentProfile(
        profile("agent-stopped", "agent-stopped"),
      );
      await limited.access.issueCredential({
        id: "cred-stopped",
        agentId: "agent-stopped",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-stopped",
      });
      await local.firestore
        .collection("agentAccess")
        .doc("agent-stopped")
        .set({ stopped: true }, { merge: true });
      await expect(
        limited.store.publishPostIdempotently(
          publishInput("agent-stopped", "cred-stopped", "stopped"),
        ),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      expect(
        (await local.firestore.collection("rateLimitBuckets").get()).size,
      ).toBe(2);
    });

    it("leaves no writes when Safety rejects and hides restricted content", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-a",
      });
      const input = publishInput("agent-a", "cred-a", "blocked");
      await local.firestore
        .collection("safetyBlocks")
        .doc("agent-a")
        .set({ blocked: true });
      const auditsBefore = (
        await local.firestore.collection("auditRecords").get()
      ).size;
      await expect(
        adapters.store.publishPostIdempotently(input),
      ).rejects.toThrow("safety_blocked");
      expect((await local.firestore.collection("publicItems").get()).size).toBe(
        0,
      );
      expect(
        (await local.firestore.collection("idempotencyRecords").get()).size,
      ).toBe(0);
      expect(
        (await local.firestore.collection("auditRecords").get()).size,
      ).toBe(auditsBefore);

      await local.firestore.collection("safetyBlocks").doc("agent-a").delete();
      const created = await adapters.store.publishPostIdempotently({
        ...input,
        idempotencyKey: "visible",
        requestFingerprint: "visible",
      });
      if (created.kind !== "created")
        throw new Error("Expected a created post.");
      await local.firestore
        .collection("publicItems")
        .doc(created.post.id)
        .update({
          visibility: "hidden",
        });
      await expect(
        adapters.store.findVisiblePublicPostById(created.post.id),
      ).resolves.toBeNull();
      await expect(
        adapters.store.listVisiblePublicPostsByAgent("agent-a"),
      ).resolves.toHaveLength(0);
      await expect(
        adapters.store.listPublicTimelinePage({ limit: 100 }),
      ).resolves.toMatchObject({
        items: [],
      });
    });

    it.each(["stopped", "suspended"] as const)(
      "serializes publish against an agent becoming %s",
      async (status) => {
        const agentId = `agent-${status}`;
        const credentialId = `cred-${status}`;
        await adapters.identity.createAgentProfile(profile(agentId, agentId));
        await adapters.access.issueCredential({
          id: credentialId,
          agentId,
          secretDigest: "digest:secret",
          createdAt: at,
          expiresAt: null,
          actorOperatorId: "operator-a",
          correlationId: `issue-${status}`,
        });
        const block = local.firestore.runTransaction(async (transaction) => {
          const profileRef = local.firestore
            .collection("agentProfiles")
            .doc(agentId);
          const accessRef = local.firestore
            .collection("agentAccess")
            .doc(agentId);
          await Promise.all([
            transaction.get(profileRef),
            transaction.get(accessRef),
          ]);
          transaction.update(profileRef, { status });
          if (status === "stopped")
            transaction.set(accessRef, { stopped: true }, { merge: true });
        });
        const publish = adapters.store.publishPostIdempotently(
          publishInput(agentId, credentialId, `race-${status}`),
        );
        await Promise.allSettled([block, publish]);
        const blockedAt = new Date(at.getTime() + 1);
        await expect(
          adapters.store.publishPostIdempotently({
            ...publishInput(agentId, credentialId, `after-${status}`),
            occurredAt: blockedAt,
          }),
        ).rejects.toMatchObject({
          code: status === "stopped" ? "invalid_credential" : "agent_suspended",
        });
      },
    );

    it("serializes revocation against publication and replays the same public ID", async () => {
      await adapters.identity.createAgentProfile(profile("agent-a", "agent-a"));
      await adapters.access.issueCredential({
        id: "cred-a",
        agentId: "agent-a",
        secretDigest: "digest:secret",
        createdAt: at,
        expiresAt: null,
        actorOperatorId: "operator-a",
        correlationId: "issue-a",
      });
      const input = publishInput("agent-a", "cred-a", "race");
      const results = await Promise.allSettled([
        adapters.store.publishPostIdempotently(input),
        adapters.access.revokeCredential("agent-a", "cred-a", at, {
          actorOperatorId: "operator-a",
          correlationId: "revoke-a",
        }),
      ]);
      const publish = results[0];
      if (publish.status === "fulfilled" && publish.value.kind === "created") {
        await expect(
          adapters.store.publishPostIdempotently(input),
        ).resolves.toMatchObject({
          kind: "replay",
          response: publish.value.response,
        });
      }
      await expect(
        adapters.store.publishPostIdempotently({
          ...input,
          idempotencyKey: "after-revoke",
          requestFingerprint: "after-revoke",
        }),
      ).rejects.toMatchObject({ code: "invalid_credential" });
      expect(
        (await local.firestore.collection("publicItems").get()).size,
      ).toBeLessThanOrEqual(1);
    });
  },
);

function profile(id: string, handle: string) {
  const at = new Date("2026-11-01T12:00:00.000Z");
  return {
    id,
    handle,
    displayName: handle,
    description: null,
    status: "active" as const,
    createdAt: at,
    updatedAt: at,
  };
}

function publishInput(agentId: string, credentialId: string, key: string) {
  return {
    authenticatedAgentId: agentId as never,
    credentialId,
    credentialSecret: `${credentialId}.secret`,
    idempotencyKey: key,
    requestFingerprint: key,
    text: "A deterministic observation.",
    occurredAt: new Date("2026-11-01T12:00:00.000Z"),
    correlationId: `publish-${key}`,
  };
}

function followInput(operation: "follow" | "unfollow", key: string) {
  return {
    authenticatedAgentId: "agent-a" as never,
    credentialId: "cred-a",
    credentialSecret: "cred-a.secret",
    targetAgentId: "agent-b" as never,
    targetHandle: "agent-b",
    operation,
    idempotencyKey: key,
    occurredAt: new Date("2026-11-01T12:00:00.000Z"),
    correlationId: `${operation}-${key}`,
  };
}

function repostInput(sourcePostId: string, key: string) {
  return {
    authenticatedAgentId: "agent-a" as never,
    credentialId: "cred-a",
    credentialSecret: "cred-a.secret",
    sourcePostId: sourcePostId as never,
    idempotencyKey: key,
    occurredAt: new Date("2026-11-01T12:00:01.000Z"),
    correlationId: `repost-${key}`,
  };
}

function acknowledgementInput(postId: string, key: string) {
  return {
    authenticatedAgentId: "agent-a" as never,
    credentialId: "cred-a",
    credentialSecret: "cred-a.secret",
    postId: postId as never,
    idempotencyKey: key,
    occurredAt: new Date("2026-11-01T12:00:02.000Z"),
    correlationId: `acknowledgement-${key}`,
  };
}

function feedPost(id: string, authorId: string, publishedAt: Timestamp) {
  return {
    id,
    type: "post",
    authorId,
    authorHandle: authorId,
    authorDisplayName: authorId,
    text: id,
    publishedAt,
    parentId: null,
    conversationRootId: id,
    visibility: "visible",
    acknowledgementTotal: 0,
  };
}

function readResponseId(response: { readonly body: unknown }): string {
  return (response.body as { data: { id: string } }).data.id;
}
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import {
  AgentProofRejectedError,
  agentRecoveryInputFingerprint,
  createAgentRecoveryChallenge,
  createAgentRegistrationAttempt,
  recoveryProofMessage,
  registrationProofMessage,
  type Ed25519PublicJwk,
} from "@nobody-asked/access";
