export const ROUTING_RECOVERY_SCOPE = Object.freeze({
  projectId: "gen-lang-client-0607406471",
  region: "us-central1",
  service: "nobody-asked-api",
  databaseId: "nobody-asked-dev",
});

export interface RoutingInspection {
  readonly projectId: string;
  readonly region: string;
  readonly service: string;
  readonly traffic: Readonly<Record<string, number>>;
  readonly revisions: Readonly<
    Record<
      string,
      {
        readonly ready: boolean;
        readonly imageDigest: string;
        readonly databaseId: string;
        readonly configurationDigest: string;
        readonly contractDigest: string;
      }
    >
  >;
}

export interface RoutingProbe {
  readonly publicRead: boolean;
  readonly authorizedWrite: boolean;
  readonly readBack: boolean;
  readonly auditAttribution: boolean;
  readonly agentId: string;
  readonly postId: string;
}

export interface RoutingRecoveryReport {
  readonly scope: "same_image_routing_recovery";
  readonly result: "pass" | "fail";
  readonly phase: string;
  readonly failurePhase: string | null;
  readonly checks: readonly string[];
  readonly publicFixtureIds: readonly string[];
  readonly trafficRestored: boolean | null;
  readonly cleanup: "not_attempted" | "stopped" | "failed";
  readonly unverified: readonly [
    "prior_code_rollback",
    "provider_rollback",
    "operator_mail_delivery",
    "moderator_authority",
  ];
}

export interface RoutingRecoveryCallbacks {
  readonly inspect: () => Promise<RoutingInspection>;
  // Root binds these callbacks to one in-memory synthetic Agent and validates
  // actual HTTP responses and read-only Audit attribution. No cookies or keys
  // cross this primitive's interface. Metadata comparison alone proves no flow.
  readonly preflight: (
    revisions: readonly [string, string],
  ) => Promise<readonly [RoutingProbe, RoutingProbe]>;
  readonly verifyMain: (revision: string) => Promise<RoutingProbe>;
  readonly selectTraffic: (
    target: typeof ROUTING_RECOVERY_SCOPE & { readonly revision: string },
  ) => Promise<void>;
  readonly cleanup: () => Promise<boolean>;
}

function requireCheck(value: unknown): asserts value {
  if (!value) throw new Error("Routing recovery check failed.");
}
function verifyProbe(probe: RoutingProbe) {
  requireCheck(
    probe.publicRead === true &&
      probe.authorizedWrite === true &&
      probe.readBack === true &&
      probe.auditAttribution === true,
  );
  requireCheck(
    /^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/.test(probe.agentId) &&
      /^[a-z0-9]+(?:[-_:][a-z0-9]+)*$/.test(probe.postId),
  );
}

// Pure orchestration only: this module has no HTTP, gcloud, filesystem, email,
// credentials, role grants, or executable CLI. Root owns reviewed callbacks.
export async function verifySameImageRoutingRecovery(input: {
  readonly standbyRevision: string;
  readonly currentRevision: string;
  readonly currentImage: string;
  readonly callbacks: RoutingRecoveryCallbacks;
}): Promise<RoutingRecoveryReport> {
  const currentRevision = input.currentRevision;
  const currentImage = input.currentImage;
  requireCheck(/^nobody-asked-api-[a-z0-9-]+$/.test(currentRevision));
  requireCheck(/^sha256:[a-f0-9]{64}$/.test(currentImage));
  requireCheck(/^nobody-asked-api-[a-z0-9-]+$/.test(input.standbyRevision));
  requireCheck(input.standbyRevision !== currentRevision);
  const obsolete = new Set([
    "nobody-asked-api-34a6746",
    "nobody-asked-api-9abc820",
    "nobody-asked-api-icloud-1a84899",
    "nobody-asked-api-recovery-379cca2",
    "nobody-asked-api-hosting-d433acc",
  ]);
  requireCheck(!obsolete.has(currentRevision));
  requireCheck(!obsolete.has(input.standbyRevision));
  const callbacks = input.callbacks;
  const checks: string[] = [];
  const publicIds = new Set<string>();
  let phase = "initial_inspection";
  let restored: boolean | null = null;
  let cleanup: RoutingRecoveryReport["cleanup"] = "not_attempted";
  let touched = false;
  let passed = false;
  let failurePhase: string | null = null;
  let configurationDigest: string | undefined;
  let contractDigest: string | undefined;
  let fixtureAgentId: string | undefined;
  const inspect = async (servingRevision: string) => {
    const actual = await callbacks.inspect();
    requireCheck(
      actual.projectId === ROUTING_RECOVERY_SCOPE.projectId &&
        actual.region === ROUTING_RECOVERY_SCOPE.region &&
        actual.service === ROUTING_RECOVERY_SCOPE.service,
    );
    const serving = Object.entries(actual.traffic).filter(
      ([, percent]) => percent !== 0,
    );
    requireCheck(
      serving.length === 1 &&
        serving[0]![0] === servingRevision &&
        serving[0]![1] === 100,
    );
    const current = actual.revisions[currentRevision];
    const standby = actual.revisions[input.standbyRevision];
    requireCheck(current && standby);
    requireCheck(
      /^[a-f0-9]{64}$/.test(current.configurationDigest) &&
        /^[a-f0-9]{64}$/.test(current.contractDigest),
    );
    configurationDigest ??= current.configurationDigest;
    contractDigest ??= current.contractDigest;
    for (const revision of [current, standby]) {
      requireCheck(
        revision.ready === true &&
          revision.imageDigest === currentImage &&
          revision.databaseId === ROUTING_RECOVERY_SCOPE.databaseId,
      );
      requireCheck(
        revision.configurationDigest === configurationDigest &&
          revision.contractDigest === contractDigest,
      );
    }
  };
  const probe = (result: RoutingProbe) => {
    verifyProbe(result);
    publicIds.add(result.agentId);
    publicIds.add(result.postId);
  };
  try {
    await inspect(currentRevision);
    checks.push("same_image_configuration_contract_and_storage_target");
    phase = "same_image_preflight";
    const results = await callbacks.preflight([
      currentRevision,
      input.standbyRevision,
    ]);
    requireCheck(results.length === 2);
    results.forEach(probe);
    requireCheck(results[0].agentId === results[1].agentId);
    fixtureAgentId = results[0].agentId;
    checks.push(
      "same_agent_public_read_write_read_and_audit_on_both_revisions",
    );
    await inspect(currentRevision);
    phase = "standby_traffic";
    touched = true;
    await callbacks.selectTraffic({
      ...ROUTING_RECOVERY_SCOPE,
      revision: input.standbyRevision,
    });
    await inspect(input.standbyRevision);
    checks.push("standby_traffic_exact");
    phase = "standby_main_probe";
    const standbyProbe = await callbacks.verifyMain(input.standbyRevision);
    probe(standbyProbe);
    requireCheck(standbyProbe.agentId === results[0].agentId);
    checks.push("standby_main_public_read_write_read_and_audit");
    passed = true;
  } catch {
    failurePhase = phase;
    passed = false;
  } finally {
    if (touched) {
      phase = "restore_current_traffic";
      restored = false;
      try {
        await callbacks.selectTraffic({
          ...ROUTING_RECOVERY_SCOPE,
          revision: currentRevision,
        });
        await inspect(currentRevision);
        restored = true;
        checks.push("restored_current_traffic_exact");
        phase = "restored_main_probe";
        const restoredProbe = await callbacks.verifyMain(currentRevision);
        requireCheck(restoredProbe.agentId === fixtureAgentId);
        probe(restoredProbe);
        checks.push("restored_main_public_read_write_read_and_audit");
      } catch {
        failurePhase ??= phase;
        passed = false;
      }
    }
    try {
      cleanup = (await callbacks.cleanup()) ? "stopped" : "failed";
    } catch {
      cleanup = "failed";
    }
  }
  if (cleanup === "failed") failurePhase ??= "cleanup";
  if (passed && restored === true && cleanup === "stopped") phase = "complete";
  return Object.freeze({
    scope: "same_image_routing_recovery",
    result:
      passed && restored === true && cleanup === "stopped" ? "pass" : "fail",
    phase,
    failurePhase,
    checks,
    publicFixtureIds: [...publicIds],
    trafficRestored: restored,
    cleanup,
    unverified: [
      "prior_code_rollback",
      "provider_rollback",
      "operator_mail_delivery",
      "moderator_authority",
    ] as const,
  });
}
