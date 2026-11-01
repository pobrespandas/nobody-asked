export const safetyModule = "safety" as const;

export const MODERATION_REASON_CATEGORIES = [
  "spam",
  "impersonation",
  "abuse",
  "unsafe_link",
] as const;

export type ModerationReasonCategory =
  (typeof MODERATION_REASON_CATEGORIES)[number];
export type AgentId = string & { readonly __brand: "AgentId" };
export type PublicItemId = string & { readonly __brand: "PublicItemId" };
export type ModeratorId = string & { readonly __brand: "ModeratorId" };
export type ReportId = string & { readonly __brand: "ReportId" };
export type AuditRecordId = string & { readonly __brand: "AuditRecordId" };

export type ReportTarget =
  | Readonly<{ type: "agent_profile"; agentId: AgentId }>
  | Readonly<{ type: "public_item"; publicItemId: PublicItemId }>;

export interface Report {
  readonly id: ReportId;
  readonly reportingAgentId: AgentId;
  readonly target: ReportTarget;
  readonly reasonCategory: ModerationReasonCategory;
  readonly reportedAt: string;
}

export type ContentModerationState =
  | Readonly<{ publicItemId: PublicItemId; visibility: "visible" }>
  | Readonly<{
      publicItemId: PublicItemId;
      visibility: "hidden";
      reasonCategory: ModerationReasonCategory;
      actionTime: string;
    }>;

export type RestorableAgentStatus = "active" | "stopped";

export type AgentModerationState =
  | Readonly<{ agentId: AgentId; status: RestorableAgentStatus }>
  | Readonly<{
      agentId: AgentId;
      status: "suspended";
      reasonCategory: ModerationReasonCategory;
      actionTime: string;
    }>;

export type ModerationEventType =
  "content.hidden" | "content.restored" | "agent.suspended" | "agent.restored";

export type ModerationSubject =
  | Readonly<{ type: "public_item"; id: PublicItemId }>
  | Readonly<{ type: "agent"; id: AgentId }>;

export type ModerationState =
  "visible" | "hidden" | "active" | "stopped" | "suspended";

export interface ModerationAuditRecord {
  readonly id: AuditRecordId;
  readonly eventType: ModerationEventType;
  readonly moderatorId: ModeratorId;
  readonly subject: ModerationSubject;
  readonly reasonCategory: ModerationReasonCategory;
  readonly internalNote?: string;
  readonly previousState: ModerationState;
  readonly resultingState: ModerationState;
  readonly occurredAt: string;
  readonly correlationId: string;
}

export interface SafetyDependencies {
  readonly nextReportId: () => ReportId;
  readonly nextAuditRecordId: () => AuditRecordId;
  readonly now: () => Date;
}

export interface SubmitReportInput {
  readonly reportingAgentId: AgentId;
  readonly target: ReportTarget;
  readonly reasonCategory: ModerationReasonCategory;
}

export interface ModerationContext {
  readonly moderatorId: ModeratorId;
  readonly reasonCategory: ModerationReasonCategory;
  readonly internalNote?: string;
  readonly correlationId: string;
}

export interface HideContentInput extends ModerationContext {
  readonly publicItemId: PublicItemId;
}

export interface RestoreContentInput extends ModerationContext {
  readonly publicItemId: PublicItemId;
}

export interface SuspendAgentInput extends ModerationContext {
  readonly agentId: AgentId;
  readonly currentStatus: RestorableAgentStatus;
}

export interface RestoreAgentInput extends ModerationContext {
  readonly agentId: AgentId;
}

export interface StateChange<T> {
  readonly state: T;
  readonly audit: ModerationAuditRecord;
}

interface ContentRestriction {
  readonly reasonCategory: ModerationReasonCategory;
  readonly actionTime: string;
}

interface AgentRestriction extends ContentRestriction {
  readonly previousStatus: RestorableAgentStatus;
}

export class InvalidModerationReasonError extends Error {
  readonly code = "invalid_moderation_reason";

  constructor(reason: string) {
    super(`Unsupported moderation reason: ${reason}.`);
    this.name = "InvalidModerationReasonError";
  }
}

export class InvalidModerationTransitionError extends Error {
  readonly code = "invalid_moderation_transition";

  constructor(message: string) {
    super(message);
    this.name = "InvalidModerationTransitionError";
  }
}

export function isModerationReasonCategory(
  value: string,
): value is ModerationReasonCategory {
  return MODERATION_REASON_CATEGORIES.some((category) => category === value);
}

export class SafetyDomain {
  readonly #reports: Report[] = [];
  readonly #auditRecords: ModerationAuditRecord[] = [];
  readonly #hiddenContent = new Map<PublicItemId, ContentRestriction>();
  readonly #suspendedAgents = new Map<AgentId, AgentRestriction>();

  constructor(readonly dependencies: SafetyDependencies) {}

  submitReport(input: SubmitReportInput): Report {
    assertReasonCategory(input.reasonCategory);

    const report = Object.freeze({
      id: this.dependencies.nextReportId(),
      reportingAgentId: input.reportingAgentId,
      target: freezeReportTarget(input.target),
      reasonCategory: input.reasonCategory,
      reportedAt: this.dependencies.now().toISOString(),
    });

    this.#reports.push(report);
    return report;
  }

  hideContent(input: HideContentInput): StateChange<ContentModerationState> {
    assertReasonCategory(input.reasonCategory);

    if (this.#hiddenContent.has(input.publicItemId)) {
      throw new InvalidModerationTransitionError("Content is already hidden.");
    }

    const occurredAt = this.dependencies.now().toISOString();
    const restriction = Object.freeze({
      reasonCategory: input.reasonCategory,
      actionTime: occurredAt,
    });
    const state = contentHiddenState(input.publicItemId, restriction);
    const audit = this.#recordAudit({
      input,
      eventType: "content.hidden",
      subject: Object.freeze({ type: "public_item", id: input.publicItemId }),
      previousState: "visible",
      resultingState: "hidden",
      occurredAt,
    });

    this.#hiddenContent.set(input.publicItemId, restriction);
    return Object.freeze({ state, audit });
  }

  restoreContent(
    input: RestoreContentInput,
  ): StateChange<ContentModerationState> {
    assertReasonCategory(input.reasonCategory);

    if (!this.#hiddenContent.has(input.publicItemId)) {
      throw new InvalidModerationTransitionError("Content is already visible.");
    }

    const occurredAt = this.dependencies.now().toISOString();
    const state = contentVisibleState(input.publicItemId);
    const audit = this.#recordAudit({
      input,
      eventType: "content.restored",
      subject: Object.freeze({ type: "public_item", id: input.publicItemId }),
      previousState: "hidden",
      resultingState: "visible",
      occurredAt,
    });

    this.#hiddenContent.delete(input.publicItemId);
    return Object.freeze({ state, audit });
  }

  suspendAgent(input: SuspendAgentInput): StateChange<AgentModerationState> {
    assertReasonCategory(input.reasonCategory);

    if (this.#suspendedAgents.has(input.agentId)) {
      throw new InvalidModerationTransitionError("Agent is already suspended.");
    }

    const occurredAt = this.dependencies.now().toISOString();
    const restriction = Object.freeze({
      previousStatus: input.currentStatus,
      reasonCategory: input.reasonCategory,
      actionTime: occurredAt,
    });
    const state = agentSuspendedState(input.agentId, restriction);
    const audit = this.#recordAudit({
      input,
      eventType: "agent.suspended",
      subject: Object.freeze({ type: "agent", id: input.agentId }),
      previousState: input.currentStatus,
      resultingState: "suspended",
      occurredAt,
    });

    this.#suspendedAgents.set(input.agentId, restriction);
    return Object.freeze({ state, audit });
  }

  restoreAgent(input: RestoreAgentInput): StateChange<AgentModerationState> {
    assertReasonCategory(input.reasonCategory);

    const restriction = this.#suspendedAgents.get(input.agentId);
    if (!restriction) {
      throw new InvalidModerationTransitionError("Agent is not suspended.");
    }

    const occurredAt = this.dependencies.now().toISOString();
    const state = agentRestoredState(input.agentId, restriction.previousStatus);
    const audit = this.#recordAudit({
      input,
      eventType: "agent.restored",
      subject: Object.freeze({ type: "agent", id: input.agentId }),
      previousState: "suspended",
      resultingState: restriction.previousStatus,
      occurredAt,
    });

    this.#suspendedAgents.delete(input.agentId);
    return Object.freeze({ state, audit });
  }

  projectContentPublicState(
    publicItemId: PublicItemId,
  ): ContentModerationState {
    const restriction = this.#hiddenContent.get(publicItemId);
    return restriction
      ? contentHiddenState(publicItemId, restriction)
      : contentVisibleState(publicItemId);
  }

  projectAgentPublicState(
    agentId: AgentId,
    currentStatus: RestorableAgentStatus,
  ): AgentModerationState {
    const restriction = this.#suspendedAgents.get(agentId);
    return restriction
      ? agentSuspendedState(agentId, restriction)
      : agentRestoredState(agentId, currentStatus);
  }

  listInternalReports(): readonly Report[] {
    return Object.freeze([...this.#reports]);
  }

  listInternalAuditRecords(): readonly ModerationAuditRecord[] {
    return Object.freeze([...this.#auditRecords]);
  }

  #recordAudit(input: {
    readonly input: ModerationContext;
    readonly eventType: ModerationEventType;
    readonly subject: ModerationSubject;
    readonly previousState: ModerationState;
    readonly resultingState: ModerationState;
    readonly occurredAt: string;
  }): ModerationAuditRecord {
    const note = normalizeInternalNote(input.input.internalNote);
    const audit = Object.freeze({
      id: this.dependencies.nextAuditRecordId(),
      eventType: input.eventType,
      moderatorId: input.input.moderatorId,
      subject: input.subject,
      reasonCategory: input.input.reasonCategory,
      ...(note === undefined ? {} : { internalNote: note }),
      previousState: input.previousState,
      resultingState: input.resultingState,
      occurredAt: input.occurredAt,
      correlationId: input.input.correlationId,
    });

    this.#auditRecords.push(audit);
    return audit;
  }
}

function assertReasonCategory(
  reason: string,
): asserts reason is ModerationReasonCategory {
  if (!isModerationReasonCategory(reason)) {
    throw new InvalidModerationReasonError(reason);
  }
}

function normalizeInternalNote(note: string | undefined): string | undefined {
  const normalized = note?.trim();
  return normalized ? normalized : undefined;
}

function freezeReportTarget(target: ReportTarget): ReportTarget {
  return target.type === "agent_profile"
    ? Object.freeze({ type: target.type, agentId: target.agentId })
    : Object.freeze({ type: target.type, publicItemId: target.publicItemId });
}

function contentVisibleState(
  publicItemId: PublicItemId,
): ContentModerationState {
  return Object.freeze({ publicItemId, visibility: "visible" });
}

function contentHiddenState(
  publicItemId: PublicItemId,
  restriction: ContentRestriction,
): ContentModerationState {
  return Object.freeze({
    publicItemId,
    visibility: "hidden",
    reasonCategory: restriction.reasonCategory,
    actionTime: restriction.actionTime,
  });
}

function agentRestoredState(
  agentId: AgentId,
  status: RestorableAgentStatus,
): AgentModerationState {
  return Object.freeze({ agentId, status });
}

function agentSuspendedState(
  agentId: AgentId,
  restriction: AgentRestriction,
): AgentModerationState {
  return Object.freeze({
    agentId,
    status: "suspended",
    reasonCategory: restriction.reasonCategory,
    actionTime: restriction.actionTime,
  });
}
