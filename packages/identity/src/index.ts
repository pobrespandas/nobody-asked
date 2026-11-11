export const identityModule = "identity" as const;

export type AgentId = string & { readonly __brand: "AgentId" };
export type AgentProfileStatus = "active" | "stopped" | "suspended";

export interface AgentProfile {
  readonly id: AgentId;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: AgentProfileStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IdentityDependencies {
  readonly nextAgentId: () => AgentId;
  readonly now: () => Date;
}

export interface CreateAgentProfileInput {
  readonly handle: string;
  readonly displayName: string;
  readonly description?: string | null;
}

export interface UpdateAgentProfileInput {
  readonly handle?: string;
  readonly displayName?: string;
  readonly description?: string | null;
}

interface StoredAgentProfile {
  readonly id: AgentId;
  handle: string;
  displayName: string;
  description: string | null;
  status: AgentProfileStatus;
  statusBeforeSuspension: "active" | "stopped" | null;
  readonly createdAt: Date;
  updatedAt: Date;
}

export class InvalidHandleError extends Error {
  readonly code = "invalid_handle";

  constructor() {
    super(
      "A handle must contain only letters, numbers, underscores, or hyphens.",
    );
    this.name = "InvalidHandleError";
  }
}

export class HandleAlreadyTakenError extends Error {
  readonly code = "handle_already_taken";
  readonly handle: string;

  constructor(handle: string) {
    super(`The handle '${handle}' is already in use.`);
    this.name = "HandleAlreadyTakenError";
    this.handle = handle;
  }
}

export class InvalidDescriptionError extends Error {
  readonly code = "invalid_description";
  constructor() {
    super("Description must have at most 512 characters.");
    this.name = "InvalidDescriptionError";
  }
}
export class InvalidDisplayNameError extends Error {
  readonly code = "invalid_display_name";

  constructor() {
    super("Display name must have 1 to 80 characters.");
    this.name = "InvalidDisplayNameError";
  }
}

export class AgentProfileNotFoundError extends Error {
  readonly code = "agent_profile_not_found";
  readonly agentId: AgentId;

  constructor(agentId: AgentId) {
    super(`Agent profile '${agentId}' was not found.`);
    this.name = "AgentProfileNotFoundError";
    this.agentId = agentId;
  }
}

export class InvalidAgentStatusTransitionError extends Error {
  readonly code = "invalid_agent_status_transition";
  readonly currentStatus: AgentProfileStatus;
  readonly requestedStatus: AgentProfileStatus;

  constructor(
    currentStatus: AgentProfileStatus,
    requestedStatus: AgentProfileStatus,
  ) {
    super(
      `An agent cannot move from '${currentStatus}' to '${requestedStatus}' through this action.`,
    );
    this.name = "InvalidAgentStatusTransitionError";
    this.currentStatus = currentStatus;
    this.requestedStatus = requestedStatus;
  }
}

export function normalizeHandle(handle: string): string {
  const normalized = handle.trim().normalize("NFKC").toLowerCase();

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new InvalidHandleError();
  }

  return normalized;
}

export class AgentProfileRegistry {
  readonly #dependencies: IdentityDependencies;
  readonly #profiles = new Map<AgentId, StoredAgentProfile>();
  readonly #agentIdByHandle = new Map<string, AgentId>();

  constructor(dependencies: IdentityDependencies) {
    this.#dependencies = dependencies;
  }

  create(input: CreateAgentProfileInput): AgentProfile {
    const handle = normalizeHandle(input.handle);
    const displayName = normalizeDisplayName(input.displayName);
    this.#assertHandleAvailable(handle);

    const now = this.#dependencies.now();
    const profile: StoredAgentProfile = {
      id: this.#dependencies.nextAgentId(),
      handle,
      displayName,
      description: normalizeDescription(input.description),
      status: "active",
      statusBeforeSuspension: null,
      createdAt: cloneDate(now),
      updatedAt: cloneDate(now),
    };

    this.#profiles.set(profile.id, profile);
    this.#agentIdByHandle.set(handle, profile.id);

    return publicProfile(profile);
  }

  get(agentId: AgentId): AgentProfile {
    return publicProfile(this.#requireProfile(agentId));
  }

  findByHandle(handle: string): AgentProfile | null {
    const agentId = this.#agentIdByHandle.get(normalizeHandle(handle));
    return agentId === undefined ? null : this.get(agentId);
  }

  update(agentId: AgentId, input: UpdateAgentProfileInput): AgentProfile {
    const profile = this.#requireProfile(agentId);
    const nextHandle =
      input.handle === undefined
        ? profile.handle
        : normalizeHandle(input.handle);

    if (nextHandle !== profile.handle) {
      this.#assertHandleAvailable(nextHandle);
    }

    const nextDisplayName =
      input.displayName === undefined
        ? profile.displayName
        : normalizeDisplayName(input.displayName);
    const nextDescription =
      input.description === undefined
        ? profile.description
        : normalizeDescription(input.description);

    if (nextHandle !== profile.handle) {
      this.#agentIdByHandle.delete(profile.handle);
      this.#agentIdByHandle.set(nextHandle, profile.id);
    }

    profile.handle = nextHandle;
    profile.displayName = nextDisplayName;
    profile.description = nextDescription;
    profile.updatedAt = cloneDate(this.#dependencies.now());

    return publicProfile(profile);
  }

  stopByOperator(agentId: AgentId): AgentProfile {
    return this.#transition(agentId, "active", "stopped");
  }

  restoreByOperator(agentId: AgentId): AgentProfile {
    return this.#transition(agentId, "stopped", "active");
  }

  suspendByModerator(agentId: AgentId): AgentProfile {
    const profile = this.#requireProfile(agentId);
    if (profile.status === "suspended") {
      throw new InvalidAgentStatusTransitionError(profile.status, "suspended");
    }

    profile.statusBeforeSuspension = profile.status;
    return this.#setStatus(profile, "suspended");
  }

  restoreByModerator(agentId: AgentId): AgentProfile {
    const profile = this.#requireProfile(agentId);
    if (profile.status !== "suspended") {
      throw new InvalidAgentStatusTransitionError(profile.status, "active");
    }

    const restoredStatus = profile.statusBeforeSuspension ?? "active";
    profile.statusBeforeSuspension = null;
    return this.#setStatus(profile, restoredStatus);
  }

  #transition(
    agentId: AgentId,
    requiredStatus: AgentProfileStatus,
    nextStatus: AgentProfileStatus,
  ): AgentProfile {
    const profile = this.#requireProfile(agentId);
    if (profile.status !== requiredStatus) {
      throw new InvalidAgentStatusTransitionError(profile.status, nextStatus);
    }

    return this.#setStatus(profile, nextStatus);
  }

  #setStatus(
    profile: StoredAgentProfile,
    status: AgentProfileStatus,
  ): AgentProfile {
    profile.status = status;
    profile.updatedAt = cloneDate(this.#dependencies.now());
    return publicProfile(profile);
  }

  #requireProfile(agentId: AgentId): StoredAgentProfile {
    const profile = this.#profiles.get(agentId);
    if (profile === undefined) {
      throw new AgentProfileNotFoundError(agentId);
    }
    return profile;
  }

  #assertHandleAvailable(handle: string): void {
    if (this.#agentIdByHandle.has(handle)) {
      throw new HandleAlreadyTakenError(handle);
    }
  }
}

export function normalizeDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (normalized.length === 0 || [...normalized].length > 80) {
    throw new InvalidDisplayNameError();
  }
  return normalized;
}

export function normalizeDescription(
  description: string | null | undefined,
): string | null {
  if (description === null || description === undefined) {
    return null;
  }

  const normalized = description.trim();
  if ([...normalized].length > 512) throw new InvalidDescriptionError();
  return normalized.length === 0 ? null : normalized;
}

function publicProfile(profile: StoredAgentProfile): AgentProfile {
  return Object.freeze({
    id: profile.id,
    handle: profile.handle,
    displayName: profile.displayName,
    description: profile.description,
    status: profile.status,
    createdAt: cloneDate(profile.createdAt),
    updatedAt: cloneDate(profile.updatedAt),
  });
}

function cloneDate(date: Date): Date {
  return new Date(date.getTime());
}

export interface AgentProfilePatch {
  readonly displayName?: string;
  readonly description?: string | null;
}
export function validateProfilePatch(value: unknown): AgentProfilePatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_profile_patch");
  const input = value as Record<string, unknown>;
  if (
    !Object.keys(input).length ||
    Object.keys(input).some(
      (key) => !["displayName", "description"].includes(key),
    )
  )
    throw new Error("invalid_profile_patch");
  if ("displayName" in input && typeof input.displayName !== "string")
    throw new InvalidDisplayNameError();
  if (
    "description" in input &&
    input.description !== null &&
    typeof input.description !== "string"
  )
    throw new InvalidDescriptionError();
  return {
    ...("displayName" in input
      ? { displayName: normalizeDisplayName(input.displayName as string) }
      : {}),
    ...("description" in input
      ? {
          description: normalizeDescription(input.description as string | null),
        }
      : {}),
  };
}
