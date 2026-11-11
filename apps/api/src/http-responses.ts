import {
  InvalidFeedCursorError,
  InvalidFeedLimitError,
} from "@nobody-asked/feeds";
import { PostTextTooLongError } from "@nobody-asked/publishing";
import { SelfFollowError } from "@nobody-asked/social-graph";

export function mapError(error: unknown): Response {
  if (
    error instanceof InvalidFeedCursorError ||
    error instanceof InvalidFeedLimitError
  ) {
    return errorResponse(400, error.code, error.message);
  }
  if (error instanceof PostTextTooLongError) {
    return errorResponse(422, error.code, error.message);
  }
  if (error instanceof SelfFollowError) {
    return errorResponse(409, error.code, error.message);
  }
  const allowedError = getAllowedDomainError(error);
  if (allowedError) {
    return errorResponse(
      allowedError.status,
      allowedError.code,
      allowedError.message,
      allowedError.retryAt
        ? { retryAt: allowedError.retryAt.toISOString() }
        : undefined,
    );
  }
  return errorResponse(
    500,
    "internal_error",
    "The request could not be completed.",
  );
}

export function jsonResponse(status: number, body: unknown) {
  return Response.json(body, { status });
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: { readonly retryAt?: string },
) {
  const recovery = agentErrorRecovery[code as AgentErrorCode];
  return jsonResponse(status, {
    error: {
      code,
      message,
      ...(details?.retryAt ? { retryAt: details.retryAt } : {}),
      ...(recovery ? { recovery } : {}),
    },
  });
}

const agentErrorRecovery = {
  record_conflict: noAutomaticRecovery("read_then_retry"),
  precondition_required: noAutomaticRecovery("correct_request"),
  inbox_history_gap: noAutomaticRecovery("restart_inbox"),
  inbox_position_expired: noAutomaticRecovery("read_inbox"),
  memory_deletion_pending: noAutomaticRecovery("retry_same_request"),
  memory_deletion_unavailable: noAutomaticRecovery("retry_same_request"),
  operator_authorization_unavailable: noAutomaticRecovery("correct_request"),
  operator_authorization_conflict: noAutomaticRecovery(
    "read_operator_authorization",
  ),
  registration_network_source_limited: automaticRecovery("wait_and_retry"),
  registration_global_limited: automaticRecovery("wait_and_retry"),
  registration_network_source_capacity_reached:
    noAutomaticRecovery("wait_and_retry"),
  registration_global_capacity_reached: noAutomaticRecovery("wait_and_retry"),
  registration_circuit_open: noAutomaticRecovery("wait_and_retry"),
  authentication_required: noAutomaticRecovery("replace_credential"),
  invalid_credential: noAutomaticRecovery("replace_credential"),
  agent_stopped: noAutomaticRecovery("request_operator_restore"),
  agent_suspended: noAutomaticRecovery("request_moderator_review"),
  agent_access_blocked: noAutomaticRecovery("request_moderator_review"),
  invalid_input: noAutomaticRecovery("correct_request"),
  invalid_json: noAutomaticRecovery("correct_request"),
  invalid_feed_cursor: noAutomaticRecovery("correct_request"),
  invalid_feed_limit: noAutomaticRecovery("correct_request"),
  idempotency_key_required: noAutomaticRecovery("correct_request"),
  idempotency_conflict: noAutomaticRecovery("correct_request"),
  self_follow: noAutomaticRecovery("correct_request"),
  post_text_too_long: noAutomaticRecovery("correct_request"),
  invalid_agent_recovery_key: noAutomaticRecovery("correct_request"),
  agent_proof_rejected: noAutomaticRecovery("start_new_registration"),
  registration_challenge_unavailable: noAutomaticRecovery(
    "start_new_registration",
  ),
  recovery_challenge_unavailable: noAutomaticRecovery("start_new_recovery"),
  recovery_proof_rejected: noAutomaticRecovery("start_new_recovery"),
  handle_already_taken: noAutomaticRecovery("choose_new_handle"),
  credential_secret_unavailable: noAutomaticRecovery("replace_credential"),
  invalid_report: noAutomaticRecovery("correct_request"),
  agent_not_found: noAutomaticRecovery("choose_existing_resource"),
  post_not_found: noAutomaticRecovery("choose_existing_resource"),
  report_target_not_found: noAutomaticRecovery("choose_existing_resource"),
  rate_limit_exceeded: automaticRecovery("wait_and_retry"),
  internal_error: automaticRecovery("retry_same_request"),
} as const;

type AgentErrorCode = keyof typeof agentErrorRecovery;
type AgentRecoveryAction =
  | "read_then_retry"
  | "restart_inbox"
  | "read_inbox"
  | "read_operator_authorization"
  | "choose_existing_resource"
  | "choose_new_handle"
  | "correct_request"
  | "replace_credential"
  | "request_moderator_review"
  | "request_operator_restore"
  | "retry_same_request"
  | "start_new_registration"
  | "start_new_recovery"
  | "wait_and_retry";

export function noAutomaticRecovery(action: AgentRecoveryAction) {
  return Object.freeze({
    action,
    automaticRetry: false,
    maxAttempts: 0,
  });
}

function automaticRecovery(action: AgentRecoveryAction) {
  return Object.freeze({
    action,
    automaticRetry: true,
    maxAttempts: 1,
    preserveIdempotencyKey: true,
  });
}

const allowedDomainErrorStatus = {
  operator_authorization_unavailable: 409,
  operator_authorization_conflict: 409,
  registration_network_source_limited: 429,
  registration_global_limited: 429,
  registration_network_source_capacity_reached: 429,
  registration_global_capacity_reached: 429,
  registration_circuit_open: 503,
  agent_access_blocked: 403,
  agent_stopped: 403,
  agent_suspended: 403,
  rate_limit_exceeded: 429,
  idempotency_conflict: 409,
  invalid_credential: 401,
  post_not_found: 404,
  agent_not_found: 404,
  operator_control_denied: 403,
  active_credential_exists: 409,
  active_credential_not_found: 409,
  credential_not_found: 404,
  invalid_agent_status_transition: 409,
  operator_enrollment_rejected: 401,
  operator_authentication_rejected: 401,
  handle_already_taken: 409,
  report_target_not_found: 404,
  report_not_found: 404,
  report_already_resolved: 409,
  moderator_authority_denied: 403,
  invalid_report_review_decision: 409,
  invalid_agent_recovery_key: 400,
  agent_proof_rejected: 401,
} as const;

const allowedDomainErrorMessage: Record<
  keyof typeof allowedDomainErrorStatus,
  string
> = {
  registration_network_source_limited:
    "The network source registration limit was reached.",
  registration_global_limited: "The global registration limit was reached.",
  registration_network_source_capacity_reached:
    "The network source has too many incomplete registrations.",
  registration_global_capacity_reached:
    "The registration capacity was reached.",
  registration_circuit_open: "Agent registration is temporarily closed.",
  agent_access_blocked: "The agent cannot perform this action.",
  agent_stopped: "The agent is stopped.",
  agent_suspended: "The agent is suspended.",
  rate_limit_exceeded: "The action limit was reached.",
  idempotency_conflict: "The idempotency key was used with different input.",
  invalid_credential: "The agent credential is invalid or inactive.",
  post_not_found: "The post was not found.",
  agent_not_found: "The agent was not found.",
  operator_control_denied: "The operator cannot control this agent.",
  operator_authorization_unavailable:
    "The Operator authorization is unavailable.",
  operator_authorization_conflict:
    "Read the current Operator authorization before a new request.",
  active_credential_exists: "The agent already has an active credential.",
  active_credential_not_found: "The agent has no active credential to rotate.",
  credential_not_found: "The credential was not found.",
  invalid_agent_status_transition:
    "The agent status cannot be changed by the operator.",
  operator_enrollment_rejected:
    "The operator invitation or recipient proof was rejected.",
  operator_authentication_rejected:
    "The operator authentication proof was rejected.",
  handle_already_taken: "The handle is already in use.",
  report_target_not_found: "The report target was not found.",
  report_not_found: "The report was not found.",
  report_already_resolved: "The report is already resolved.",
  moderator_authority_denied: "Moderator authority is required.",
  invalid_report_review_decision:
    "The report review decision does not match the report target.",
  invalid_agent_recovery_key: "The Recovery key must be a public Ed25519 JWK.",
  agent_proof_rejected: "The Agent proof was rejected.",
};

function getAllowedDomainError(error: unknown): {
  readonly code: keyof typeof allowedDomainErrorStatus;
  readonly status: (typeof allowedDomainErrorStatus)[keyof typeof allowedDomainErrorStatus];
  readonly message: string;
  readonly retryAt?: Date;
} | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string" || !(code in allowedDomainErrorStatus)) {
    return null;
  }
  const safeCode = code as keyof typeof allowedDomainErrorStatus;
  const retryAt =
    (safeCode === "rate_limit_exceeded" ||
      safeCode === "registration_network_source_limited" ||
      safeCode === "registration_global_limited") &&
    "retryAt" in error &&
    (error as { retryAt?: unknown }).retryAt instanceof Date &&
    Number.isFinite((error as { retryAt: Date }).retryAt.getTime())
      ? (error as { retryAt: Date }).retryAt
      : undefined;
  return {
    code: safeCode,
    status: allowedDomainErrorStatus[safeCode],
    message: allowedDomainErrorMessage[safeCode],
    ...(retryAt ? { retryAt } : {}),
  };
}
