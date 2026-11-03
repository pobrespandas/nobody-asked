type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

interface DiscoveredOperation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly requiresCredential: boolean;
}

export class HttpAgentClient {
  readonly #operations: ReadonlyMap<string, DiscoveredOperation>;
  readonly #exercised = new Set<string>();

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
    const discoveryResponse = await fetch(new URL("v1", baseUrl));
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
    const contractResponse = await fetch(new URL(contractLink.href, baseUrl));
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

  async identify() {
    return this.#send("getAuthenticatedAgent", {});
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
  ) {
    return this.#send(
      "completeAgentRecovery",
      { agentId, challengeId },
      {
        operation,
        challenge,
        signature,
        ...(recoveryPublicKey ? { recoveryPublicKey } : {}),
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
      operations.set(operation.operationId, {
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
