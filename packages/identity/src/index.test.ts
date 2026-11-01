import { describe, expect, it, vi } from "vitest";

import {
  AgentProfileRegistry,
  HandleAlreadyTakenError,
  InvalidAgentStatusTransitionError,
  InvalidHandleError,
  normalizeHandle,
  type AgentId,
} from "./index.js";

const createdAt = new Date("2026-11-01T02:00:00.000Z");
const changedAt = new Date("2026-11-01T03:00:00.000Z");

function createRegistry() {
  let id = 0;
  const now = vi.fn(() => createdAt);
  const nextAgentId = vi.fn(() => `agent-${++id}` as AgentId);

  return {
    registry: new AgentProfileRegistry({ nextAgentId, now }),
    nextAgentId,
    now,
  };
}

describe("agent profile registration", () => {
  it("normalizes a handle and exposes only public profile fields", () => {
    const { registry } = createRegistry();

    const profile = registry.create({
      handle: "  Ａgent_One  ",
      displayName: " Agent One ",
      description: " First network agent. ",
    });

    expect(profile).toEqual({
      id: "agent-1",
      handle: "agent_one",
      displayName: "Agent One",
      description: "First network agent.",
      status: "active",
      createdAt,
      updatedAt: createdAt,
    });
    expect(Object.keys(profile).sort()).toEqual([
      "createdAt",
      "description",
      "displayName",
      "handle",
      "id",
      "status",
      "updatedAt",
    ]);
    expect(Object.isFrozen(profile)).toBe(true);

    profile.createdAt.setUTCFullYear(2000);
    expect(registry.get(profile.id).createdAt).toEqual(createdAt);
  });

  it("enforces normalized handle uniqueness before it requests an ID", () => {
    const { registry, nextAgentId } = createRegistry();
    registry.create({ handle: "Agent-One", displayName: "First" });

    expect(() =>
      registry.create({ handle: " agent-one ", displayName: "Second" }),
    ).toThrow(HandleAlreadyTakenError);
    expect(nextAgentId).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid handle", () => {
    expect(() => normalizeHandle("not a handle")).toThrow(InvalidHandleError);
    expect(() => normalizeHandle("@agent")).toThrow(InvalidHandleError);
  });

  it("moves the handle reservation when a profile changes handle", () => {
    const { registry, now } = createRegistry();
    const first = registry.create({ handle: "first", displayName: "First" });
    registry.create({ handle: "second", displayName: "Second" });
    now.mockReturnValue(changedAt);

    const changed = registry.update(first.id, {
      handle: "renamed",
      displayName: "Renamed",
      description: " Updated. ",
    });

    expect(changed).toMatchObject({
      handle: "renamed",
      displayName: "Renamed",
      description: "Updated.",
      updatedAt: changedAt,
    });
    expect(registry.findByHandle("FIRST")).toBeNull();
    expect(registry.findByHandle("RENAMED")?.id).toBe(first.id);
    expect(() => registry.update(first.id, { handle: "SECOND" })).toThrow(
      HandleAlreadyTakenError,
    );
    expect(registry.get(first.id).handle).toBe("renamed");
  });
});

describe("agent profile status", () => {
  it("supports operator stop and restore transitions", () => {
    const { registry, now } = createRegistry();
    const profile = registry.create({ handle: "agent", displayName: "Agent" });
    now.mockReturnValue(changedAt);

    expect(registry.stopByOperator(profile.id)).toMatchObject({
      status: "stopped",
      updatedAt: changedAt,
    });
    expect(registry.restoreByOperator(profile.id).status).toBe("active");
  });

  it("supports moderator suspension from active or stopped", () => {
    const { registry } = createRegistry();
    const active = registry.create({ handle: "active", displayName: "Active" });
    const stopped = registry.create({
      handle: "stopped",
      displayName: "Stopped",
    });
    registry.stopByOperator(stopped.id);

    expect(registry.suspendByModerator(active.id).status).toBe("suspended");
    expect(registry.suspendByModerator(stopped.id).status).toBe("suspended");
    expect(registry.restoreByModerator(active.id).status).toBe("active");
    expect(registry.restoreByModerator(stopped.id).status).toBe("stopped");
  });

  it("rejects authority-specific invalid transitions without changing state", () => {
    const { registry, now } = createRegistry();
    const profile = registry.create({ handle: "agent", displayName: "Agent" });
    registry.suspendByModerator(profile.id);
    const callsBeforeRejection = now.mock.calls.length;

    expect(() => registry.stopByOperator(profile.id)).toThrow(
      InvalidAgentStatusTransitionError,
    );
    expect(() => registry.restoreByOperator(profile.id)).toThrow(
      InvalidAgentStatusTransitionError,
    );
    expect(registry.get(profile.id).status).toBe("suspended");
    expect(now).toHaveBeenCalledTimes(callsBeforeRejection);
  });
});
