import { describe, expect, it, vi } from "vitest";

import {
  acknowledgePost,
  createSocialGraphState,
  followAgent,
  FollowAlreadyExistsError,
  getAcknowledgementTotal,
  SelfFollowError,
  unfollowAgent,
  type AgentId,
  type PostId,
} from "./index.js";

const alice = "agent-alice" as AgentId;
const bob = "agent-bob" as AgentId;
const clara = "agent-clara" as AgentId;
const postOne = "post-1" as PostId;
const postTwo = "post-2" as PostId;
const recordedAt = new Date("2026-11-01T02:00:00.000Z");

describe("follow", () => {
  it("creates a directed follow without changing the input state", () => {
    const initialState = createSocialGraphState();

    const result = followAgent({ now: () => recordedAt }, initialState, {
      followerId: alice,
      followedId: bob,
    });

    expect(result.follow).toEqual({
      followerId: alice,
      followedId: bob,
      followedAt: recordedAt,
    });
    expect(result.state.follows).toEqual([result.follow]);
    expect(initialState.follows).toEqual([]);
  });

  it("rejects a self-follow before it reads the clock", () => {
    const now = vi.fn(() => recordedAt);

    expect(() =>
      followAgent({ now }, createSocialGraphState(), {
        followerId: alice,
        followedId: alice,
      }),
    ).toThrow(SelfFollowError);
    expect(now).not.toHaveBeenCalled();
  });

  it("rejects a duplicate follow before it reads the clock", () => {
    const first = followAgent(
      { now: () => recordedAt },
      createSocialGraphState(),
      { followerId: alice, followedId: bob },
    );
    const now = vi.fn(() => recordedAt);

    expect(() =>
      followAgent({ now }, first.state, {
        followerId: alice,
        followedId: bob,
      }),
    ).toThrow(FollowAlreadyExistsError);
    expect(now).not.toHaveBeenCalled();
  });
});

describe("unfollow", () => {
  it("removes only the selected follow", () => {
    const first = followAgent(
      { now: () => recordedAt },
      createSocialGraphState(),
      { followerId: alice, followedId: bob },
    );
    const second = followAgent({ now: () => recordedAt }, first.state, {
      followerId: alice,
      followedId: clara,
    });

    const result = unfollowAgent(second.state, {
      followerId: alice,
      followedId: bob,
    });

    expect(result.removed).toBe(true);
    expect(result.state.follows).toEqual([second.follow]);
  });

  it("does not change state when the follow does not exist", () => {
    const state = createSocialGraphState();

    const result = unfollowAgent(state, {
      followerId: alice,
      followedId: bob,
    });

    expect(result).toEqual({ state, removed: false });
    expect(result.state).toBe(state);
  });
});

describe("acknowledgement", () => {
  it("returns the existing acknowledgement for a repeated action", () => {
    const now = vi.fn(() => recordedAt);
    const first = acknowledgePost({ now }, createSocialGraphState(), {
      agentId: alice,
      postId: postOne,
    });

    const repeated = acknowledgePost({ now }, first.state, {
      agentId: alice,
      postId: postOne,
    });

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.acknowledgement).toBe(first.acknowledgement);
    expect(repeated.state).toBe(first.state);
    expect(now).toHaveBeenCalledTimes(1);
    expect(getAcknowledgementTotal(repeated.state, postOne)).toBe(1);
  });

  it("reports public totals for each post", () => {
    const first = acknowledgePost(
      { now: () => recordedAt },
      createSocialGraphState(),
      { agentId: alice, postId: postOne },
    );
    const second = acknowledgePost({ now: () => recordedAt }, first.state, {
      agentId: bob,
      postId: postOne,
    });
    const third = acknowledgePost({ now: () => recordedAt }, second.state, {
      agentId: clara,
      postId: postTwo,
    });

    expect(getAcknowledgementTotal(third.state, postOne)).toBe(2);
    expect(getAcknowledgementTotal(third.state, postTwo)).toBe(1);
    expect(getAcknowledgementTotal(third.state, "post-3" as PostId)).toBe(0);
  });
});
