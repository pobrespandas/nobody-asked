export const socialGraphModule = "social-graph" as const;

export type AgentId = string & { readonly __brand: "AgentId" };
export type PostId = string & { readonly __brand: "PostId" };

export interface Follow {
  readonly followerId: AgentId;
  readonly followedId: AgentId;
  readonly followedAt: Date;
}

export interface Acknowledgement {
  readonly agentId: AgentId;
  readonly postId: PostId;
  readonly acknowledgedAt: Date;
}

export interface SocialGraphState {
  readonly follows: readonly Follow[];
  readonly acknowledgements: readonly Acknowledgement[];
}

export interface SocialGraphDependencies {
  readonly now: () => Date;
}

export interface FollowInput {
  readonly followerId: AgentId;
  readonly followedId: AgentId;
}

export interface AcknowledgePostInput {
  readonly agentId: AgentId;
  readonly postId: PostId;
}

export interface FollowResult {
  readonly state: SocialGraphState;
  readonly follow: Follow;
}

export interface UnfollowResult {
  readonly state: SocialGraphState;
  readonly removed: boolean;
}

export interface AcknowledgePostResult {
  readonly state: SocialGraphState;
  readonly acknowledgement: Acknowledgement;
  readonly created: boolean;
}

export class SelfFollowError extends Error {
  readonly code = "self_follow";

  constructor() {
    super("An agent cannot follow itself.");
    this.name = "SelfFollowError";
  }
}

export class FollowAlreadyExistsError extends Error {
  readonly code = "follow_already_exists";

  constructor() {
    super("The follow already exists.");
    this.name = "FollowAlreadyExistsError";
  }
}

export function createSocialGraphState(): SocialGraphState {
  return freezeState([], []);
}

export function followAgent(
  dependencies: SocialGraphDependencies,
  state: SocialGraphState,
  input: FollowInput,
): FollowResult {
  if (input.followerId === input.followedId) {
    throw new SelfFollowError();
  }

  if (findFollow(state, input)) {
    throw new FollowAlreadyExistsError();
  }

  const follow = Object.freeze({
    followerId: input.followerId,
    followedId: input.followedId,
    followedAt: dependencies.now(),
  });

  return Object.freeze({
    state: freezeState([...state.follows, follow], state.acknowledgements),
    follow,
  });
}

export function unfollowAgent(
  state: SocialGraphState,
  input: FollowInput,
): UnfollowResult {
  const follow = findFollow(state, input);

  if (!follow) {
    return Object.freeze({ state, removed: false });
  }

  return Object.freeze({
    state: freezeState(
      state.follows.filter((candidate) => candidate !== follow),
      state.acknowledgements,
    ),
    removed: true,
  });
}

export function acknowledgePost(
  dependencies: SocialGraphDependencies,
  state: SocialGraphState,
  input: AcknowledgePostInput,
): AcknowledgePostResult {
  const existing = state.acknowledgements.find(
    (acknowledgement) =>
      acknowledgement.agentId === input.agentId &&
      acknowledgement.postId === input.postId,
  );

  if (existing) {
    return Object.freeze({
      state,
      acknowledgement: existing,
      created: false,
    });
  }

  const acknowledgement = Object.freeze({
    agentId: input.agentId,
    postId: input.postId,
    acknowledgedAt: dependencies.now(),
  });

  return Object.freeze({
    state: freezeState(state.follows, [
      ...state.acknowledgements,
      acknowledgement,
    ]),
    acknowledgement,
    created: true,
  });
}

export function getAcknowledgementTotal(
  state: SocialGraphState,
  postId: PostId,
): number {
  return state.acknowledgements.filter(
    (acknowledgement) => acknowledgement.postId === postId,
  ).length;
}

function findFollow(
  state: SocialGraphState,
  input: FollowInput,
): Follow | undefined {
  return state.follows.find(
    (follow) =>
      follow.followerId === input.followerId &&
      follow.followedId === input.followedId,
  );
}

function freezeState(
  follows: readonly Follow[],
  acknowledgements: readonly Acknowledgement[],
): SocialGraphState {
  return Object.freeze({
    follows: Object.freeze([...follows]),
    acknowledgements: Object.freeze([...acknowledgements]),
  });
}
