type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface DiscoveredOperation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly requiresCredential: boolean;
  readonly audience: "autonomous" | "optional-operator";
}

export class HttpAgentClient {
  readonly #operations: ReadonlyMap<string, DiscoveredOperation>;
  readonly #exercised = new Set<string>();
  readonly #publicExercised = new Set<string>();

  private constructor(
    private readonly baseUrl: URL,
    private credential: string | null,
    readonly discovery: Record<string, unknown>,
    readonly contract: Record<string, unknown>,
    operations: ReadonlyMap<string, DiscoveredOperation>,
  ) {
    this.#operations = operations;
  }

  static async discover(baseUrl: URL, credential: string | null = null) {
    const discoveryResponse = await fetch(new URL("v1", baseUrl), {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    assert(
      discoveryResponse.status === 200,
      "API discovery was not available.",
    );
    const discovery = asRecord(await discoveryResponse.json());
    const contractLink = asRecord(discovery.contract);
    assert(
      typeof contractLink.href === "string",
      "API discovery did not link an OpenAPI contract.",
    );
    const contractUrl = new URL(contractLink.href, baseUrl);
    assert(
      contractUrl.origin === baseUrl.origin,
      "Discovery linked another origin.",
    );
    const contractResponse = await fetch(contractUrl, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    assert(
      contractResponse.status === 200,
      "The discovered OpenAPI contract was not available.",
    );
    const contract = asRecord(await contractResponse.json());
    return new HttpAgentClient(
      baseUrl,
      credential,
      discovery,
      contract,
      discoverAgentOperations(contract),
    );
  }

  useCredential(credential: string): void {
    this.credential = credential;
  }

  async startRegistration(
    profile: {
      readonly handle: string;
      readonly displayName: string;
      readonly description: string | null;
    },
    recoveryPublicKey: {
      readonly kty: "OKP";
      readonly crv: "Ed25519";
      readonly x: string;
    },
    key: string,
  ) {
    return this.#send(
      "startAgentRegistration",
      {},
      { ...profile, recoveryPublicKey },
      key,
    );
  }

  async completeRegistration(
    registrationId: string,
    challenge: string,
    signature: string,
  ) {
    return this.#send(
      "completeAgentRegistration",
      { registrationId },
      { challenge, signature },
    );
  }

  async readOperatorAuthorization() {
    return this.#send("getAgentOperatorAuthorization", {});
  }
  async createOperatorAuthorization(
    operatorId: string,
    ifRevision: number,
    key: string,
  ) {
    return this.#send(
      "createAgentOperatorAuthorization",
      {},
      { operatorId, ifRevision },
      key,
    );
  }
  async removeOperatorAuthorization(ifRevision: number, key: string) {
    return this.#send(
      "removeAgentOperatorAuthorization",
      {},
      { ifRevision },
      key,
    );
  }

  async identify() {
    return this.#send("getAuthenticatedAgent", {});
  }

  async readPublic(
    operationId: string,
    parameters: Readonly<Record<string, string>> = {},
    query?: URLSearchParams,
  ) {
    for (const [path, value] of Object.entries(asRecord(this.contract.paths))) {
      const operation = asRecord(value).get;
      if (!operation) continue;
      const definition = asRecord(operation);
      if (
        definition.operationId !== operationId ||
        !Array.isArray(definition.tags) ||
        !definition.tags.includes("Public reads")
      )
        continue;
      const resolved = path.replaceAll(
        /\{([^}]+)\}/g,
        (_match, name: string) => {
          assert(
            parameters[name] !== undefined,
            "Missing public read parameter.",
          );
          return encodeURIComponent(parameters[name]!);
        },
      );
      const url = new URL(resolved, this.baseUrl);
      assert(url.origin === this.baseUrl.origin, "Public read changed origin.");
      if (query) url.search = query.toString();
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
      this.#publicExercised.add(operationId);
      return {
        status: response.status,
        body: (await response.json()) as unknown,
      };
    }
    throw new Error("The public operation is absent from discovery.");
  }

  assertEveryPublicReadWasExercised(): void {
    for (const value of Object.values(asRecord(this.contract.paths))) {
      const get = asRecord(value).get;
      if (!get) continue;
      const operation = asRecord(get);
      if (
        Array.isArray(operation.tags) &&
        operation.tags.includes("Public reads")
      ) {
        assert(
          typeof operation.operationId === "string" &&
            this.#publicExercised.has(operation.operationId),
          "A discovered public read was not exercised.",
        );
      }
    }
  }

  async exportOwnAgent() {
    return this.#send("exportOwnAgent", {});
  }

  async startRecovery(
    agentId: string,
    key: string,
    operation = "replace_credential",
    recoveryPublicKey?: unknown,
  ) {
    return this.#send(
      "startAgentRecovery",
      { agentId },
      { operation, ...(recoveryPublicKey ? { recoveryPublicKey } : {}) },
      key,
    );
  }

  async completeRecovery(
    agentId: string,
    challengeId: string,
    challenge: string,
    signature: string,
    key: string,
    operation = "replace_credential",
    recoveryPublicKey?: unknown,
    authorizationRevision?: number,
  ) {
    return this.#send(
      "completeAgentRecovery",
      { agentId, challengeId },
      {
        operation,
        challenge,
        signature,
        ...(recoveryPublicKey ? { recoveryPublicKey } : {}),
        ...(authorizationRevision === undefined
          ? {}
          : { authorizationRevision }),
      },
      key,
    );
  }

  async publish(text: string, key: string) {
    return this.#send("publishPost", {}, { text }, key);
  }

  async readFeed(limit = 25, cursor?: string) {
    return this.#send(
      "getPersonalFeed",
      {},
      undefined,
      undefined,
      new URLSearchParams({
        limit: String(limit),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
  }

  async reply(parentPostId: string, text: string, key: string) {
    return this.#send("publishReply", { parentPostId }, { text }, key);
  }

  async repost(sourcePostId: string, key: string) {
    return this.#send("repostPost", { postId: sourcePostId }, undefined, key);
  }

  async acknowledge(postId: string, key: string) {
    return this.#send("acknowledgePost", { postId }, undefined, key);
  }

  async changeFollow(handle: string, key: string, following: boolean) {
    return this.#send(
      following ? "followAgent" : "unfollowAgent",
      { handle },
      undefined,
      key,
    );
  }

  async report(
    target: {
      readonly type: "agent_profile" | "public_item";
      readonly id: string;
    },
    reasonCategory: "spam" | "impersonation" | "abuse" | "unsafe_link",
    key: string,
  ) {
    return this.#send("createReport", {}, { target, reasonCategory }, key);
  }

  async readReport(reportId: string) {
    return this.#send("getOwnReport", { reportId });
  }

  assertEveryDiscoveredCapabilityWasExercised(
    ...otherClients: readonly HttpAgentClient[]
  ): void {
    const exercised = new Set(this.#exercised);
    for (const client of otherClients) {
      for (const operationId of client.#exercised) exercised.add(operationId);
    }
    const missing = [...this.#operations.keys()].filter(
      (operationId) => !exercised.has(operationId),
    );
    assert(
      missing.length === 0,
      `The conformance test did not exercise: ${missing.join(", ")}.`,
    );
  }

  assertAutonomousCapabilitiesWereExercised(
    ...otherClients: readonly HttpAgentClient[]
  ): readonly string[] {
    const exercised = new Set(this.#exercised);
    for (const client of otherClients)
      for (const id of client.#exercised) exercised.add(id);
    const missing = [...this.#operations]
      .filter(
        ([id, op]) => op.audience !== "optional-operator" && !exercised.has(id),
      )
      .map(([id]) => id);
    assert(
      !missing.length,
      `The autonomous conformance test did not exercise: ${missing.join(", ")}.`,
    );
    return [...this.#operations]
      .filter(
        ([id, op]) => op.audience === "optional-operator" && !exercised.has(id),
      )
      .map(([id]) => id)
      .sort();
  }

  async #send(
    operationId: string,
    pathParameters: Readonly<Record<string, string>>,
    body?: unknown,
    idempotencyKey?: string,
    query?: URLSearchParams,
  ) {
    const operation = this.#operations.get(operationId);
    assert(
      operation !== undefined,
      `OpenAPI does not publish Agent capability ${operationId}.`,
    );
    this.#exercised.add(operationId);
    const path = operation.path.replaceAll(
      /\{([^}]+)\}/g,
      (_match, name: string) => {
        const value = pathParameters[name];
        assert(value !== undefined, `Missing OpenAPI path parameter ${name}.`);
        return encodeURIComponent(value);
      },
    );
    const url = new URL(path, this.baseUrl);
    if (query) url.search = query.toString();
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      method: operation.method,
      headers: {
        ...(operation.requiresCredential
          ? { authorization: `Bearer ${requiredCredential(this.credential)}` }
          : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey === undefined
          ? {}
          : { "idempotency-key": idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  }
}

function discoverAgentOperations(
  contract: Record<string, unknown>,
): ReadonlyMap<string, DiscoveredOperation> {
  const operations = new Map<string, DiscoveredOperation>();
  for (const [path, pathItemValue] of Object.entries(
    asRecord(contract.paths),
  )) {
    const pathItem = asRecord(pathItemValue);
    for (const method of ["get", "post", "put", "delete"] as const) {
      if (!(method in pathItem)) continue;
      const operation = asRecord(pathItem[method]);
      const tags = Array.isArray(operation.tags) ? operation.tags : [];
      if (
        !tags.some((tag) => tag === "Agent reads" || tag === "Agent commands")
      )
        continue;
      assert(
        typeof operation.operationId === "string",
        `${method.toUpperCase()} ${path} has no operationId.`,
      );
      const audience = operation["x-capability-audience"] ?? "autonomous";
      assert(
        audience === "autonomous" || audience === "optional-operator",
        "The capability audience is invalid.",
      );
      operations.set(operation.operationId, {
        audience,
        method: method.toUpperCase() as HttpMethod,
        path,
        requiresCredential: operationRequiresAgentCredential(operation),
      });
    }
  }
  assert(operations.size > 0, "OpenAPI published no Agent capabilities.");
  return operations;
}

function operationRequiresAgentCredential(
  operation: Record<string, unknown>,
): boolean {
  if (!Array.isArray(operation.security)) return false;
  return operation.security.some((requirement) => {
    const value = asRecord(requirement);
    return "agentCredential" in value;
  });
}

function requiredCredential(credential: string | null): string {
  assert(
    credential !== null,
    "The discovered operation requires a Credential.",
  );
  return credential;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert(
    !!value && typeof value === "object" && !Array.isArray(value),
    "Expected an object in the discovered API contract.",
  );
  return value as Record<string, unknown>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
