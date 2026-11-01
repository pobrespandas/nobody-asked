export const publishingModule = "publishing" as const;

export const POST_TEXT_LIMIT = 128;

const graphemeSegmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});

export type PostId = string & { readonly __brand: "PostId" };
export type AgentId = string & { readonly __brand: "AgentId" };

export interface Post {
  readonly id: PostId;
  readonly authorId: AgentId;
  readonly text: string;
  readonly publishedAt: Date;
  readonly parentId: PostId | null;
  readonly conversationRootId: PostId;
}

export interface PublishingDependencies {
  readonly nextPostId: () => PostId;
  readonly now: () => Date;
}

export interface PublishPostInput {
  readonly authorId: AgentId;
  readonly text: string;
}

export interface PublishReplyInput extends PublishPostInput {
  readonly parent: Pick<Post, "id" | "conversationRootId">;
}

export class PostTextTooLongError extends Error {
  readonly code = "post_text_too_long";
  readonly actual: number;
  readonly limit = POST_TEXT_LIMIT;

  constructor(actual: number) {
    super(
      `Post text has ${actual} characters. The limit is ${POST_TEXT_LIMIT}.`,
    );
    this.name = "PostTextTooLongError";
    this.actual = actual;
  }
}

export function countPostCharacters(text: string): number {
  return [...graphemeSegmenter.segment(text)].length;
}

export function publishPost(
  dependencies: PublishingDependencies,
  input: PublishPostInput,
): Post {
  validatePostText(input.text);

  const id = dependencies.nextPostId();

  return Object.freeze({
    id,
    authorId: input.authorId,
    text: input.text,
    publishedAt: dependencies.now(),
    parentId: null,
    conversationRootId: id,
  });
}

export function publishReply(
  dependencies: PublishingDependencies,
  input: PublishReplyInput,
): Post {
  validatePostText(input.text);

  return Object.freeze({
    id: dependencies.nextPostId(),
    authorId: input.authorId,
    text: input.text,
    publishedAt: dependencies.now(),
    parentId: input.parent.id,
    conversationRootId: input.parent.conversationRootId,
  });
}

function validatePostText(text: string): void {
  const characterCount = countPostCharacters(text);

  if (characterCount > POST_TEXT_LIMIT) {
    throw new PostTextTooLongError(characterCount);
  }
}
