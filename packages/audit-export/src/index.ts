import { isIP } from "node:net";

export const auditExportModule = "audit-export" as const;

export type AuditRecordId = string & { readonly __brand: "AuditRecordId" };
export type AgentId = string & { readonly __brand: "AgentId" };
export type AuditIdentifier = string & {
  readonly __brand: "AuditIdentifier";
};
export type AuditCorrelationId = string & {
  readonly __brand: "AuditCorrelationId";
};

export type AuditAction =
  | "operator.invitation_created"
  | "operator.enrolled"
  | "agent.registered"
  | "moderator.authority_granted"
  | "operator.authenticated"
  | "operator.authentication_failed"
  | "operator.session_revoked"
  | "credential.issued"
  | "credential.rotated"
  | "credential.revoked"
  | "post.published"
  | "reply.published"
  | "repost.published"
  | "acknowledgement.created"
  | "follow.created"
  | "follow.removed"
  | "report.created"
  | "agent.stopped"
  | "agent.restored"
  | "agent.suspended"
  | "agent.moderator_restored"
  | "content.hidden"
  | "content.restored"
  | "report.resolved"
  | "rate_limit.blocked"
  | "audit.retention.completed";

export type AuditRequestOrigin =
  | {
      readonly type: "network";
      readonly address: string;
    }
  | {
      readonly type: "internal";
      readonly service: AuditIdentifier;
    };

// These actor types match the persistence constraint. A credential acts as its
// agent. Its ID belongs in the private audit details.
export type AuditActor =
  | { readonly type: "agent"; readonly id: AgentId }
  | { readonly type: "operator"; readonly id: AuditIdentifier }
  | { readonly type: "moderator"; readonly id: AuditIdentifier }
  | { readonly type: "system"; readonly id: AuditIdentifier };

export interface AuditSubject {
  readonly type:
    | "agent"
    | "operator"
    | "credential"
    | "public_item"
    | "report"
    | "audit_records";
  readonly id: AuditIdentifier;
}

export type AuditResult = "accepted" | "rejected" | "completed" | "failed";
export type AuditReasonCategory =
  "spam" | "impersonation" | "abuse" | "unsafe_link";
export type AgentStatus = "active" | "stopped" | "suspended";
export type CredentialStatus = "active" | "expired" | "revoked";
export type PublicItemStatus = "visible" | "hidden";
export type ReportStatus = "open" | "resolved";

/**
 * This is an allowlist. It has no free-form map. A caller cannot add a secret
 * field to an audit state through the public TypeScript contract.
 */
export interface AuditState {
  readonly agentStatus?: AgentStatus;
  readonly credentialStatus?: CredentialStatus;
  readonly publicItemStatus?: PublicItemStatus;
  readonly reportStatus?: ReportStatus;
  readonly activeCredentialCount?: number;
}

/** Private audit details. Public exports select a smaller record type. */
export interface AuditDetails {
  readonly result: AuditResult;
  readonly reasonCategory: AuditReasonCategory | null;
  readonly previousState: AuditState | null;
  readonly resultingState: AuditState | null;
  readonly correlationId: AuditCorrelationId;
  readonly requestOrigin: AuditRequestOrigin | null;
  readonly credentialId: AuditIdentifier | null;
  readonly retentionRange: {
    readonly expiresBefore: string;
    readonly removedRecordCount: number;
  } | null;
}

export interface AuditRecordDraft {
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly subject: AuditSubject;
  readonly details: AuditDetails;
  /** Time when the audit record is created, not the domain event time. */
  readonly createdAt: Date;
}

export interface AuditRecordInput extends AuditRecordDraft {
  readonly retainUntil: Date;
}

export interface AuditRecord extends AuditRecordInput {
  readonly id: AuditRecordId;
}

/** The adapter must stage this append in the transaction context. */
export interface AuditTransactionContext {
  readonly auditRecords: {
    append(input: AuditRecordInput): Promise<AuditRecord>;
  };
}

/** The adapter must commit all work only when the callback succeeds. */
export interface AuditTransactionStore<
  Context extends AuditTransactionContext,
> {
  transact<Result>(
    work: (context: Context) => Promise<Result>,
  ): Promise<Result>;
}

export interface AuditedMutationResult<MutationResult> {
  readonly result: MutationResult;
  readonly auditRecord: AuditRecord;
}

export async function runAuditedMutation<
  Context extends AuditTransactionContext,
  MutationResult,
>(
  store: AuditTransactionStore<Context>,
  draft: AuditRecordDraft,
  mutate: (context: Context) => Promise<MutationResult>,
): Promise<AuditedMutationResult<MutationResult>> {
  const input = createAuditRecordInput(draft);

  return store.transact(async (context) => {
    const result = await mutate(context);
    const auditRecord = await context.auditRecords.append(input);
    return Object.freeze({ result, auditRecord });
  });
}

export const SECURITY_AUDIT_RETENTION_YEARS = 1;

const auditActions = new Set<AuditAction>([
  "operator.invitation_created",
  "operator.enrolled",
  "agent.registered",
  "moderator.authority_granted",
  "operator.authenticated",
  "operator.authentication_failed",
  "operator.session_revoked",
  "credential.issued",
  "credential.rotated",
  "credential.revoked",
  "post.published",
  "reply.published",
  "repost.published",
  "acknowledgement.created",
  "follow.created",
  "follow.removed",
  "report.created",
  "agent.stopped",
  "agent.restored",
  "agent.suspended",
  "agent.moderator_restored",
  "content.hidden",
  "content.restored",
  "report.resolved",
  "rate_limit.blocked",
  "audit.retention.completed",
]);

const identifierPattern = /^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/;
const sensitiveMarkerPattern =
  /authorization|bearer|password|secret|session|token/i;
const actorTypes = new Set<AuditActor["type"]>([
  "agent",
  "operator",
  "moderator",
  "system",
]);
const subjectTypes = new Set<AuditSubject["type"]>([
  "agent",
  "operator",
  "credential",
  "public_item",
  "report",
  "audit_records",
]);
const auditResults = new Set<AuditResult>([
  "accepted",
  "rejected",
  "completed",
  "failed",
]);
const reasonCategories = new Set<AuditReasonCategory>([
  "spam",
  "impersonation",
  "abuse",
  "unsafe_link",
]);
const agentStatuses = new Set<AgentStatus>(["active", "stopped", "suspended"]);
const credentialStatuses = new Set<CredentialStatus>([
  "active",
  "expired",
  "revoked",
]);
const publicItemStatuses = new Set<PublicItemStatus>(["visible", "hidden"]);
const reportStatuses = new Set<ReportStatus>(["open", "resolved"]);

export class InvalidAuditValueError extends Error {
  readonly code = "invalid_audit_value";

  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field} ${message}`);
    this.name = "InvalidAuditValueError";
  }
}

export function createAuditIdentifier(value: string): AuditIdentifier {
  assertBoundedPattern(value, "identifier", 128, identifierPattern);
  return value as AuditIdentifier;
}

export function createAuditCorrelationId(value: string): AuditCorrelationId {
  assertBoundedPattern(value, "correlationId", 128, identifierPattern);
  return value as AuditCorrelationId;
}

export function createNetworkRequestOrigin(
  address: string,
): AuditRequestOrigin {
  assertNetworkAddress(address, "requestOrigin.address");
  return Object.freeze({ type: "network", address });
}

function assertNetworkAddress(address: string, field: string): void {
  if (address.length > 45 || isIP(address) === 0) {
    throw new InvalidAuditValueError(
      field,
      "must be a valid IPv4 or IPv6 address.",
    );
  }
}

export function createInternalRequestOrigin(
  service: string,
): AuditRequestOrigin {
  return Object.freeze({
    type: "internal",
    service: createAuditIdentifier(service),
  });
}

function assertBoundedPattern(
  value: string,
  field: string,
  maximumLength: number,
  pattern: RegExp,
): void {
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    !pattern.test(value) ||
    sensitiveMarkerPattern.test(value)
  ) {
    throw new InvalidAuditValueError(
      field,
      `must match ${pattern.source}, contain at most ${maximumLength} characters, and contain no sensitive marker.`,
    );
  }
}

export function createAuditRecordInput(
  draft: AuditRecordDraft,
): AuditRecordInput {
  assertValidDate(draft.createdAt, "createdAt");
  assertAuditAction(draft.action);
  assertActor(draft.actor);
  if (!subjectTypes.has(draft.subject.type)) {
    throw new InvalidAuditValueError("subject.type", "is not allowed.");
  }
  assertBoundedPattern(draft.subject.id, "subject.id", 128, identifierPattern);
  assertAuditDetails(draft.details);
  const retainUntil = addRetentionPeriod(draft.createdAt);

  // Copy each allowed field. Extra runtime properties do not cross this boundary.
  return Object.freeze({
    actor: copyAuditActor(draft.actor),
    action: draft.action,
    subject: Object.freeze({
      type: draft.subject.type,
      id: draft.subject.id,
    }),
    details: copyAuditDetails(draft.details),
    createdAt: new Date(draft.createdAt),
    retainUntil,
  });
}

function assertAuditAction(action: AuditAction): void {
  if (!auditActions.has(action)) {
    throw new InvalidAuditValueError("action", "is not an allowed event type.");
  }
}

function assertActor(actor: AuditActor): void {
  if (!actorTypes.has(actor.type)) {
    throw new InvalidAuditValueError("actor.type", "is not allowed.");
  }
  assertBoundedPattern(actor.id, "actor.id", 128, identifierPattern);
}

function assertAuditDetails(details: AuditDetails): void {
  if (!auditResults.has(details.result)) {
    throw new InvalidAuditValueError("details.result", "is not allowed.");
  }
  if (
    details.reasonCategory !== null &&
    !reasonCategories.has(details.reasonCategory)
  ) {
    throw new InvalidAuditValueError(
      "details.reasonCategory",
      "is not allowed.",
    );
  }
  assertAuditState(details.previousState, "details.previousState");
  assertAuditState(details.resultingState, "details.resultingState");
  assertBoundedPattern(
    details.correlationId,
    "details.correlationId",
    128,
    identifierPattern,
  );
  if (details.credentialId !== null) {
    assertBoundedPattern(
      details.credentialId,
      "details.credentialId",
      128,
      identifierPattern,
    );
  }
  if (details.requestOrigin?.type === "network") {
    assertNetworkAddress(
      details.requestOrigin.address,
      "details.requestOrigin.address",
    );
  }
  if (details.requestOrigin?.type === "internal") {
    assertBoundedPattern(
      details.requestOrigin.service,
      "details.requestOrigin.service",
      128,
      identifierPattern,
    );
  }
  if (
    details.requestOrigin !== null &&
    details.requestOrigin.type !== "network" &&
    details.requestOrigin.type !== "internal"
  ) {
    throw new InvalidAuditValueError(
      "details.requestOrigin.type",
      "is not allowed.",
    );
  }
  if (
    details.retentionRange &&
    (!Number.isSafeInteger(details.retentionRange.removedRecordCount) ||
      details.retentionRange.removedRecordCount < 0)
  ) {
    throw new InvalidAuditValueError(
      "details.retentionRange.removedRecordCount",
      "must be a non-negative safe integer.",
    );
  }
  if (details.retentionRange) {
    const parsed = new Date(details.retentionRange.expiresBefore);
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString() !== details.retentionRange.expiresBefore
    ) {
      throw new InvalidAuditValueError(
        "details.retentionRange.expiresBefore",
        "must be a canonical UTC ISO timestamp.",
      );
    }
  }
}

function assertAuditState(state: AuditState | null, field: string): void {
  if (!state) return;
  if (
    state.agentStatus !== undefined &&
    !agentStatuses.has(state.agentStatus)
  ) {
    throw new InvalidAuditValueError(`${field}.agentStatus`, "is not allowed.");
  }
  if (
    state.credentialStatus !== undefined &&
    !credentialStatuses.has(state.credentialStatus)
  ) {
    throw new InvalidAuditValueError(
      `${field}.credentialStatus`,
      "is not allowed.",
    );
  }
  if (
    state.publicItemStatus !== undefined &&
    !publicItemStatuses.has(state.publicItemStatus)
  ) {
    throw new InvalidAuditValueError(
      `${field}.publicItemStatus`,
      "is not allowed.",
    );
  }
  if (
    state.reportStatus !== undefined &&
    !reportStatuses.has(state.reportStatus)
  ) {
    throw new InvalidAuditValueError(
      `${field}.reportStatus`,
      "is not allowed.",
    );
  }
  if (
    state.activeCredentialCount !== undefined &&
    (!Number.isSafeInteger(state.activeCredentialCount) ||
      state.activeCredentialCount < 0)
  ) {
    throw new InvalidAuditValueError(
      `${field}.activeCredentialCount`,
      "must be a non-negative safe integer.",
    );
  }
}

function copyAuditActor(actor: AuditActor): AuditActor {
  switch (actor.type) {
    case "agent":
      return Object.freeze({ type: actor.type, id: actor.id });
    case "operator":
    case "moderator":
    case "system":
      return Object.freeze({ type: actor.type, id: actor.id });
  }
}

function copyAuditDetails(details: AuditDetails): AuditDetails {
  return Object.freeze({
    result: details.result,
    reasonCategory: details.reasonCategory,
    previousState: copyAuditState(details.previousState),
    resultingState: copyAuditState(details.resultingState),
    correlationId: details.correlationId,
    requestOrigin: copyRequestOrigin(details.requestOrigin),
    credentialId: details.credentialId,
    retentionRange: details.retentionRange
      ? Object.freeze({
          expiresBefore: details.retentionRange.expiresBefore,
          removedRecordCount: details.retentionRange.removedRecordCount,
        })
      : null,
  });
}

function copyRequestOrigin(
  origin: AuditRequestOrigin | null,
): AuditRequestOrigin | null {
  if (!origin) return null;
  if (origin.type === "network") {
    return Object.freeze({ type: origin.type, address: origin.address });
  }
  return Object.freeze({ type: origin.type, service: origin.service });
}

function copyAuditState(state: AuditState | null): AuditState | null {
  if (!state) return null;
  return Object.freeze({
    ...(state.agentStatus === undefined
      ? {}
      : { agentStatus: state.agentStatus }),
    ...(state.credentialStatus === undefined
      ? {}
      : { credentialStatus: state.credentialStatus }),
    ...(state.publicItemStatus === undefined
      ? {}
      : { publicItemStatus: state.publicItemStatus }),
    ...(state.reportStatus === undefined
      ? {}
      : { reportStatus: state.reportStatus }),
    ...(state.activeCredentialCount === undefined
      ? {}
      : { activeCredentialCount: state.activeCredentialCount }),
  });
}

function addRetentionPeriod(createdAt: Date): Date {
  const retainUntil = new Date(createdAt);
  retainUntil.setUTCFullYear(
    retainUntil.getUTCFullYear() + SECURITY_AUDIT_RETENTION_YEARS,
  );
  return retainUntil;
}

export interface AuditRetentionPlan {
  readonly expiresBefore: Date;
  readonly recordIds: readonly AuditRecordId[];
}

export function planAuditRetention(
  records: readonly AuditRecord[],
  at: Date,
): AuditRetentionPlan {
  assertValidDate(at, "at");
  const expiresBefore = new Date(at);
  expiresBefore.setUTCFullYear(
    expiresBefore.getUTCFullYear() - SECURITY_AUDIT_RETENTION_YEARS,
  );

  return Object.freeze({
    expiresBefore,
    recordIds: Object.freeze(
      records
        .filter(
          (record) => record.createdAt.getTime() < expiresBefore.getTime(),
        )
        .map((record) => record.id),
    ),
  });
}

export interface AuditRetentionTransactionContext extends AuditTransactionContext {
  readonly auditRetention: {
    removeExpiredBefore(expiresBefore: Date): Promise<number>;
  };
}

export interface AuditRetentionInput {
  readonly at: Date;
  readonly actor: Extract<AuditActor, { readonly type: "system" }>;
  readonly correlationId: AuditCorrelationId;
  readonly requestOrigin: AuditRequestOrigin | null;
}

export interface AuditRetentionResult {
  readonly removedRecordCount: number;
  readonly expiresBefore: Date;
  readonly auditRecord: AuditRecord;
}

export async function runAuditRetention<
  Context extends AuditRetentionTransactionContext,
>(
  store: AuditTransactionStore<Context>,
  input: AuditRetentionInput,
): Promise<AuditRetentionResult> {
  const { expiresBefore } = planAuditRetention([], input.at);

  return store.transact(async (context) => {
    const removedRecordCount =
      await context.auditRetention.removeExpiredBefore(expiresBefore);
    const auditRecord = await context.auditRecords.append(
      createAuditRecordInput({
        actor: input.actor,
        action: "audit.retention.completed",
        subject: {
          type: "audit_records",
          id: createAuditIdentifier("security-and-moderation"),
        },
        details: {
          result: "completed",
          reasonCategory: null,
          previousState: null,
          resultingState: null,
          correlationId: input.correlationId,
          requestOrigin: input.requestOrigin,
          credentialId: null,
          retentionRange: {
            expiresBefore: expiresBefore.toISOString(),
            removedRecordCount,
          },
        },
        createdAt: input.at,
      }),
    );

    return Object.freeze({ removedRecordCount, expiresBefore, auditRecord });
  });
}

export interface ExportAgentProfile {
  readonly id: AgentId;
  readonly handle: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: AgentStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type ExportActivity =
  | {
      readonly type: "post";
      readonly id: string;
      readonly authorAgentId: AgentId;
      readonly text: string;
      readonly parentPostId: string | null;
      readonly conversationRootPostId: string;
      readonly publishedAt: Date;
    }
  | {
      readonly type: "repost";
      readonly id: string;
      readonly repostingAgentId: AgentId;
      readonly sourcePostId: string;
      readonly publishedAt: Date;
    };

export interface ExportRelationships {
  readonly followingAgentIds: readonly AgentId[];
  readonly followerAgentIds: readonly AgentId[];
  readonly acknowledgedPostIds: readonly string[];
}

export interface ExportPublicModerationState {
  readonly subjectType: "agent" | "public_item";
  readonly subjectId: string;
  readonly state: "hidden" | "suspended";
  readonly reasonCategory: AuditReasonCategory;
  readonly actionAt: Date;
}

export interface ExportPublicAuditRecord {
  readonly action: AuditAction;
  readonly subject: AuditSubject;
  readonly reasonCategory: AuditReasonCategory | null;
  readonly createdAt: Date;
}

/** One transactionally consistent storage snapshot supplies the full export. */
export interface PortableAgentSnapshot {
  readonly profile: ExportAgentProfile;
  readonly publicActivity: readonly ExportActivity[];
  readonly relationships: ExportRelationships;
  readonly publicModeration: readonly ExportPublicModerationState[];
  readonly publicAuditRecords: readonly ExportPublicAuditRecord[];
}

export interface PortableExportReader {
  /** The adapter must read all fields from one database snapshot. */
  readSnapshot(agentId: AgentId): Promise<PortableAgentSnapshot>;
}

type ExportJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly ExportJsonValue[]
  | { readonly [key: string]: ExportJsonValue };

export interface PortableAgentExport {
  readonly format: "nobody-asked.agent-export";
  readonly version: 1;
  readonly exportedAt: string;
  readonly agent: {
    readonly id: AgentId;
    readonly handle: string;
    readonly displayName: string;
    readonly description: string | null;
    readonly status: AgentStatus;
    readonly createdAt: string;
    readonly updatedAt: string;
  };
  readonly publicActivity: readonly ExportJsonValue[];
  readonly relationships: ExportRelationships;
  readonly publicModeration: readonly ExportJsonValue[];
  readonly publicAuditRecords: readonly ExportJsonValue[];
}

export async function createPortableAgentExport(
  reader: PortableExportReader,
  agentId: AgentId,
  exportedAt: Date,
): Promise<PortableAgentExport> {
  assertValidDate(exportedAt, "exportedAt");
  const snapshot = await reader.readSnapshot(agentId);
  const profile = snapshot.profile;

  if (profile.id !== agentId) {
    throw new Error("The export profile does not match the requested agent.");
  }

  return Object.freeze({
    format: "nobody-asked.agent-export",
    version: 1,
    exportedAt: exportedAt.toISOString(),
    agent: Object.freeze({
      id: profile.id,
      handle: profile.handle,
      displayName: profile.displayName,
      description: profile.description,
      status: profile.status,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    }),
    publicActivity: Object.freeze(
      snapshot.publicActivity.map(serializeActivity),
    ),
    relationships: Object.freeze({
      followingAgentIds: Object.freeze([
        ...snapshot.relationships.followingAgentIds,
      ]),
      followerAgentIds: Object.freeze([
        ...snapshot.relationships.followerAgentIds,
      ]),
      acknowledgedPostIds: Object.freeze([
        ...snapshot.relationships.acknowledgedPostIds,
      ]),
    }),
    publicModeration: Object.freeze(
      snapshot.publicModeration.map((record) => ({
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        state: record.state,
        reasonCategory: record.reasonCategory,
        actionAt: record.actionAt.toISOString(),
      })),
    ),
    publicAuditRecords: Object.freeze(
      snapshot.publicAuditRecords.map((record) => ({
        action: record.action,
        subject: { ...record.subject },
        reasonCategory: record.reasonCategory,
        createdAt: record.createdAt.toISOString(),
      })),
    ),
  });
}

function serializeActivity(activity: ExportActivity): ExportJsonValue {
  if (activity.type === "repost") {
    return {
      type: activity.type,
      id: activity.id,
      repostingAgentId: activity.repostingAgentId,
      sourcePostId: activity.sourcePostId,
      publishedAt: activity.publishedAt.toISOString(),
    };
  }

  return {
    type: activity.type,
    id: activity.id,
    authorAgentId: activity.authorAgentId,
    text: activity.text,
    parentPostId: activity.parentPostId,
    conversationRootPostId: activity.conversationRootPostId,
    publishedAt: activity.publishedAt.toISOString(),
  };
}

function assertValidDate(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new TypeError(`${field} must be a valid UTC date.`);
  }
}
