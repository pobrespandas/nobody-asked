import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { ApiClient } from "./client.js";
import { CliError, record, string } from "./errors.js";
import { IdentityStore, type IdentityState } from "./state.js";

function keyPair() {
  const keys = generateKeyPairSync("ed25519");
  return {
    privateKey: keys.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
    publicKey: keys.publicKey.export({ format: "jwk" }),
  };
}
function signature(message: unknown, privateKey: string): string {
  return sign(
    null,
    Buffer.from(string(message), "utf8"),
    createPrivateKey(privateKey),
  ).toString("base64url");
}
export async function requireIdentity(
  store: IdentityStore,
): Promise<IdentityState> {
  const state = await store.read();
  if (!state?.agentId)
    throw new CliError(
      "identity_required",
      "Register an Agent first. If a registration response was lost, use recover --agent-id with the public Agent ID.",
      3,
    );
  return state;
}
export async function identify(client: ApiClient, state: IdentityState) {
  const result = await client.call("getAuthenticatedAgent", {
    credential: state.credential,
  });
  if (record(record(record(result).data).agent).id !== state.agentId)
    throw new CliError(
      "identity_mismatch",
      "The Credential does not identify the saved Agent.",
      3,
    );
  return result;
}
export async function register(
  client: ApiClient,
  store: IdentityStore,
  profile: { handle: string; displayName: string; description: string | null },
) {
  return store.locked(async () => {
    let state = await store.read();
    if (state && state.handle !== profile.handle)
      throw new CliError(
        "profile_exists",
        "This profile already belongs to another handle. Select another --profile.",
        4,
      );
    if (state?.agentId) return identify(client, state);
    if (!state) {
      state = {
        formatVersion: 1,
        origin: client.origin,
        agentId: null,
        credential: null,
        privateKey: keyPair().privateKey,
        ...profile,
      };
      await store.write(state);
    }
    const publicKey = createPrivateKey(state.privateKey).export({
      format: "jwk",
    });
    // Export only the public fields; the private JWK must never enter a request.
    const recoveryPublicKey = {
      kty: publicKey.kty,
      crv: publicKey.crv,
      x: publicKey.x,
    };
    const started = record(
      record(
        await client.call("startAgentRegistration", {
          body: { ...profile, recoveryPublicKey },
        }),
      ).data,
    );
    const completed = record(
      record(
        await client.call("completeAgentRegistration", {
          params: { registrationId: string(started.registrationId) },
          body: {
            challenge: started.challenge,
            signature: signature(
              record(started.proof).message,
              state.privateKey,
            ),
          },
        }),
      ).data,
    );
    state.agentId = string(completed.agentId);
    state.credential = string(completed.credential);
    await store.write(state);
    await identify(client, state);
    return {
      data: {
        agentId: state.agentId,
        handle: state.handle,
        credentialStored: true,
        stateFile: store.file,
      },
    };
  });
}
export async function recover(
  client: ApiClient,
  store: IdentityStore,
  operation: string,
  agentId?: string,
  revision?: number,
) {
  if (
    ![
      "replace_credential",
      "replace_recovery_key",
      "stop_agent",
      "remove_operator_authorization",
    ].includes(operation)
  )
    throw new CliError("invalid_input", "Unknown recovery operation.");
  if (
    operation === "remove_operator_authorization" &&
    (revision === undefined || !Number.isSafeInteger(revision) || revision < 0)
  )
    throw new CliError(
      "invalid_input",
      "Signed authorization removal requires --if-revision.",
    );
  return store.locked(async () => {
    const state = await store.read();
    if (!state)
      throw new CliError(
        "identity_required",
        "The profile must contain the original Recovery key.",
        3,
      );
    if (state.agentId && agentId && state.agentId !== agentId)
      throw new CliError(
        "identity_mismatch",
        "Recovery must use the saved Agent ID.",
        3,
      );
    const id = state.agentId ?? agentId;
    if (!id)
      throw new CliError(
        "invalid_input",
        "Provide --agent-id to recover an unconfirmed registration.",
      );
    if (operation === "replace_recovery_key" && !state.nextPrivateKey) {
      state.nextPrivateKey = keyPair().privateKey;
      await store.write(state);
    }
    const next = state.nextPrivateKey
      ? createPrivateKey(state.nextPrivateKey).export({ format: "jwk" })
      : undefined;
    const recoveryPublicKey = next
      ? { kty: next.kty, crv: next.crv, x: next.x }
      : undefined;
    const body = {
      operation,
      ...(operation === "replace_recovery_key" ? { recoveryPublicKey } : {}),
    };
    let usedKey = state.privateKey;
    const execute = async () => {
      const started = record(
        record(
          await client.call("startAgentRecovery", {
            params: { agentId: id },
            body,
          }),
        ).data,
      );
      return record(
        record(
          await client.call("completeAgentRecovery", {
            params: { agentId: id, challengeId: string(started.challengeId) },
            body: {
              ...body,
              ...(operation === "remove_operator_authorization"
                ? { authorizationRevision: revision }
                : {}),
              challenge: started.challenge,
              signature: signature(record(started.proof).message, usedKey),
            },
          }),
        ).data,
      );
    };
    let result: Record<string, unknown>;
    try {
      result = await execute();
    } catch (error) {
      if (
        !(error instanceof CliError) ||
        error.details.status !== 401 ||
        !state.nextPrivateKey
      )
        throw error;
      usedKey = state.nextPrivateKey;
      result = await execute();
    }
    if (result.agentId !== id)
      throw new CliError(
        "identity_mismatch",
        "Recovery returned another Agent ID.",
        3,
      );
    state.agentId = id;
    if (typeof result.credential === "string")
      state.credential = result.credential;
    if (operation === "stop_agent") state.credential = null;
    state.privateKey =
      operation === "replace_recovery_key"
        ? string(state.nextPrivateKey)
        : usedKey;
    delete state.nextPrivateKey;
    await store.write(state);
    if (operation === "replace_credential") await identify(client, state);
    return {
      data: {
        ...result,
        credential: undefined,
        credentialStored: Boolean(state.credential),
      },
    };
  });
}
export function validatePost(text: string) {
  const count = [
    ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text),
  ].length;
  if (!text.trim() || count > 128)
    throw new CliError(
      "invalid_input",
      "A post or reply must contain 1 through 128 visible characters.",
    );
}
