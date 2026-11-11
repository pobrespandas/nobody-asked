import { describe, expect, it, vi } from "vitest";
import {
  ROUTING_RECOVERY_SCOPE,
  verifySameImageRoutingRecovery,
  type RoutingInspection,
  type RoutingProbe,
} from "./controlled-routing-recovery.js";

const ROUTING_CURRENT_REVISION = "nobody-asked-api-current-fixture";
const ROUTING_CURRENT_IMAGE = `sha256:${"e".repeat(64)}`;
const baseline = {
  currentRevision: ROUTING_CURRENT_REVISION,
  currentImage: ROUTING_CURRENT_IMAGE,
};
const standby = "nobody-asked-api-routing-standby";
const goodProbe = (postId: string): RoutingProbe => ({
  publicRead: true,
  authorizedWrite: true,
  readBack: true,
  auditAttribution: true,
  agentId: "synthetic-agent",
  postId,
});
function setup() {
  let serving = ROUTING_CURRENT_REVISION;
  const metadata = {
    ready: true,
    imageDigest: ROUTING_CURRENT_IMAGE,
    databaseId: ROUTING_RECOVERY_SCOPE.databaseId,
    configurationDigest: "a".repeat(64),
    contractDigest: "b".repeat(64),
  };
  const state: RoutingInspection = {
    ...ROUTING_RECOVERY_SCOPE,
    traffic: { [serving]: 100 },
    revisions: {
      [ROUTING_CURRENT_REVISION]: { ...metadata },
      [standby]: { ...metadata },
    },
  };
  const callbacks = {
    inspect: vi.fn(async () => ({ ...state, traffic: { [serving]: 100 } })),
    preflight: vi.fn(
      async () =>
        [
          goodProbe("current-preflight"),
          goodProbe("standby-preflight"),
        ] as const,
    ),
    verifyMain: vi.fn(async (revision: string) =>
      goodProbe(revision === standby ? "standby-post" : "restored-post"),
    ),
    selectTraffic: vi.fn(
      async (target: typeof ROUTING_RECOVERY_SCOPE & { revision: string }) => {
        serving = target.revision;
      },
    ),
    cleanup: vi.fn(async () => true),
  };
  return { state, callbacks };
}

describe("same-image routing recovery primitive", () => {
  it("checks both revisions and one Agent before routing, restores current traffic, and cleans up", async () => {
    const { callbacks } = setup();
    const report = await verifySameImageRoutingRecovery({
      ...baseline,
      standbyRevision: standby,
      callbacks,
    });
    expect(report).toMatchObject({
      result: "pass",
      scope: "same_image_routing_recovery",
      trafficRestored: true,
      cleanup: "stopped",
      failurePhase: null,
      unverified: expect.arrayContaining([
        "prior_code_rollback",
        "provider_rollback",
        "operator_mail_delivery",
        "moderator_authority",
      ]),
    });
    expect(
      callbacks.selectTraffic.mock.calls.map(([target]) => target),
    ).toEqual([
      { ...ROUTING_RECOVERY_SCOPE, revision: standby },
      { ...ROUTING_RECOVERY_SCOPE, revision: ROUTING_CURRENT_REVISION },
    ]);
    expect(callbacks.preflight.mock.invocationCallOrder[0]).toBeLessThan(
      callbacks.selectTraffic.mock.invocationCallOrder[0]!,
    );
    expect(callbacks.verifyMain).toHaveBeenNthCalledWith(1, standby);
    expect(callbacks.verifyMain).toHaveBeenNthCalledWith(
      2,
      ROUTING_CURRENT_REVISION,
    );
    expect(callbacks.cleanup).toHaveBeenCalledOnce();
  });

  it("uses the inspected deployment baseline instead of a prior release", async () => {
    const { state, callbacks } = setup();
    const revision = "nobody-asked-api-next-release";
    const image = `sha256:${"e".repeat(64)}`;
    const metadata = { ...state.revisions[standby]!, imageDigest: image };
    callbacks.inspect.mockImplementation(async () => ({
      ...state,
      traffic: { [revision]: 100 },
      revisions: { [revision]: metadata, [standby]: metadata },
    }));
    callbacks.selectTraffic.mockImplementation(async () => {
      throw new Error("Stop before routing.");
    });
    const report = await verifySameImageRoutingRecovery({
      ...baseline,
      currentRevision: revision,
      currentImage: image,
      standbyRevision: standby,
      callbacks,
    });
    expect(callbacks.preflight).toHaveBeenCalledWith([revision, standby]);
    expect(callbacks.selectTraffic).toHaveBeenLastCalledWith({
      ...ROUTING_RECOVERY_SCOPE,
      revision,
    });
    expect(report.result).toBe("fail");
    expect(report.failurePhase).toBe("standby_traffic");
  });

  it.each([
    { currentRevision: "nobody-asked-api-34a6746" },
    { currentRevision: "nobody-asked-api-9abc820" },
    { currentRevision: "nobody-asked-api-icloud-1a84899" },
    { currentRevision: "nobody-asked-api-recovery-379cca2" },
    { currentRevision: "nobody-asked-api-hosting-d433acc" },
    { currentRevision: "another-service-current" },
    { currentImage: "latest" },
    { currentImage: "sha256:invalid" },
  ])("rejects an unsafe baseline before any callback: %j", async (unsafe) => {
    const { callbacks } = setup();
    await expect(
      verifySameImageRoutingRecovery({
        ...baseline,
        ...unsafe,
        standbyRevision: standby,
        callbacks,
      }),
    ).rejects.toThrow("Routing recovery check failed.");
    for (const callback of Object.values(callbacks)) {
      expect(callback).not.toHaveBeenCalled();
    }
  });

  it.each([
    "image",
    "configuration",
    "contract",
    "database",
    "readiness",
    "target",
    "traffic",
  ])(
    "refuses incompatible %s metadata before creating a fixture or changing traffic",
    async (condition) => {
      const { state, callbacks } = setup();
      const candidate = state.revisions[standby]! as {
        ready: boolean;
        imageDigest: string;
        configurationDigest: string;
        contractDigest: string;
        databaseId: string;
      };
      if (condition === "image") candidate.imageDigest = "sha256:older-code";
      if (condition === "configuration")
        candidate.configurationDigest = "c".repeat(64);
      if (condition === "contract") candidate.contractDigest = "d".repeat(64);
      if (condition === "database") candidate.databaseId = "other-database";
      if (condition === "readiness") candidate.ready = false;
      if (condition === "target")
        callbacks.inspect.mockImplementation(async () => ({
          ...state,
          projectId: "other-project",
        }));
      if (condition === "traffic")
        callbacks.inspect.mockImplementation(async () => ({
          ...state,
          traffic: { [ROUTING_CURRENT_REVISION]: 99, [standby]: 1 },
        }));
      const report = await verifySameImageRoutingRecovery({
        ...baseline,
        standbyRevision: standby,
        callbacks,
      });
      expect(report.result).toBe("fail");
      expect(callbacks.preflight).not.toHaveBeenCalled();
      expect(callbacks.selectTraffic).not.toHaveBeenCalled();
      expect(callbacks.cleanup).toHaveBeenCalledOnce();
    },
  );

  it("never changes traffic when the real-flow preflight fails", async () => {
    const { callbacks } = setup();
    callbacks.preflight.mockResolvedValue([
      goodProbe("current"),
      { ...goodProbe("standby"), auditAttribution: false },
    ]);
    expect(
      (
        await verifySameImageRoutingRecovery({
          ...baseline,
          standbyRevision: standby,
          callbacks,
        })
      ).result,
    ).toBe("fail");
    expect(callbacks.selectTraffic).not.toHaveBeenCalled();
  });

  it.each([
    "nobody-asked-api-recovery-379cca2",
    "nobody-asked-api-hosting-d433acc",
  ])(
    "cannot select known older revision %s even if requested",
    async (standbyRevision) => {
      const { callbacks } = setup();
      await expect(
        verifySameImageRoutingRecovery({
          ...baseline,
          standbyRevision,
          callbacks,
        }),
      ).rejects.toThrow("Routing recovery check failed.");
      expect(callbacks.inspect).not.toHaveBeenCalled();
      expect(callbacks.selectTraffic).not.toHaveBeenCalled();
    },
  );

  it("restores current traffic after an uncertain standby switch and suppresses private provider errors", async () => {
    const { callbacks } = setup();
    callbacks.selectTraffic.mockImplementationOnce(async () => {
      throw new Error(
        "private-cookie private-operator-id secret-provider-detail",
      );
    });
    const report = await verifySameImageRoutingRecovery({
      ...baseline,
      standbyRevision: standby,
      callbacks,
    });
    expect(callbacks.selectTraffic).toHaveBeenNthCalledWith(2, {
      ...ROUTING_RECOVERY_SCOPE,
      revision: ROUTING_CURRENT_REVISION,
    });
    expect(report).toMatchObject({
      result: "fail",
      failurePhase: "standby_traffic",
      trafficRestored: true,
      cleanup: "stopped",
    });
    expect(JSON.stringify(report)).not.toMatch(
      /private-cookie|private-operator-id|secret-provider-detail/,
    );
  });

  it("restores traffic and verifies the restored write after a rollback-path Audit failure", async () => {
    const { callbacks } = setup();
    callbacks.verifyMain.mockResolvedValueOnce({
      ...goodProbe("invalid-audit"),
      auditAttribution: false,
    });
    const report = await verifySameImageRoutingRecovery({
      ...baseline,
      standbyRevision: standby,
      callbacks,
    });
    expect(report).toMatchObject({
      result: "fail",
      failurePhase: "standby_main_probe",
      trafficRestored: true,
      cleanup: "stopped",
    });
    expect(callbacks.verifyMain).toHaveBeenNthCalledWith(
      2,
      ROUTING_CURRENT_REVISION,
    );
  });

  it("rejects a reused post as evidence of a new main-endpoint write", async () => {
    const { callbacks } = setup();
    callbacks.verifyMain.mockResolvedValueOnce(goodProbe("standby-preflight"));
    const report = await verifySameImageRoutingRecovery({
      ...baseline,
      standbyRevision: standby,
      callbacks,
    });
    expect(report).toMatchObject({
      result: "fail",
      failurePhase: "standby_main_probe",
      trafficRestored: true,
      cleanup: "stopped",
    });
  });

  it("reports traffic drift after preflight without writing traffic", async () => {
    const { state, callbacks } = setup();
    callbacks.inspect
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({ ...state, traffic: { [standby]: 100 } });
    const report = await verifySameImageRoutingRecovery({
      ...baseline,
      standbyRevision: standby,
      callbacks,
    });
    expect(report).toMatchObject({
      result: "fail",
      failurePhase: "pre_switch_inspection",
      trafficRestored: null,
    });
    expect(callbacks.selectTraffic).not.toHaveBeenCalled();
  });

  it("reports restoration and cleanup failure without declaring a successful drill", async () => {
    const { callbacks } = setup();
    callbacks.selectTraffic
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("private transport error");
      });
    callbacks.cleanup.mockResolvedValue(false);
    const report = await verifySameImageRoutingRecovery({
      ...baseline,
      standbyRevision: standby,
      callbacks,
    });
    expect(report).toMatchObject({
      result: "fail",
      trafficRestored: false,
      cleanup: "failed",
    });
    expect(JSON.stringify(report)).not.toContain("private transport error");
  });
});
