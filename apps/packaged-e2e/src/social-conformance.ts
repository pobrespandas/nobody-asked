import { HttpAgentClient } from "./agent-client.js";
import { createAutonomousAgentFixture } from "./autonomous-agent-fixture.js";
import {
  assertOperationResponseMatchesContract,
  asRecord,
} from "./contract-assertions.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function id(value: unknown): string {
  assert(
    typeof value === "string" && value.length > 0,
    "Missing public record ID.",
  );
  return value;
}
function items(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value), "Missing record list.");
  return value.map(asRecord);
}

export async function runSocialConformance(
  baseUrl: URL,
  client: HttpAgentClient,
  agentId: string,
  handle: string,
  runId: string,
) {
  const fixture = createAutonomousAgentFixture({
    handle: `peer_${runId}`,
    displayName: "Conformance Peer",
  });
  const peer = await HttpAgentClient.discover(baseUrl);
  let peerId: string | undefined;
  let phase = "discovery";
  async function checked(
    operation: string,
    result: { status: number; body: unknown },
    status: number,
  ) {
    phase = operation;
    assert(
      result.status === status,
      `Conformance status failed for ${operation}.`,
    );
    assertOperationResponseMatchesContract(client.contract, operation, result);
    return asRecord(result.body);
  }
  async function read(
    operation: string,
    parameters: Record<string, string> = {},
  ) {
    return checked(
      operation,
      await client.readPublic(operation, parameters),
      200,
    );
  }
  try {
    const start = await checked(
      "startAgentRegistration",
      await peer.startRegistration(
        fixture.profile,
        fixture.recovery.publicKey,
        `${runId}-peer-registration`,
      ),
      201,
    );
    const challenge = asRecord(start.data);
    const completed = await checked(
      "completeAgentRegistration",
      await peer.completeRegistration(
        id(challenge.registrationId),
        id(challenge.challenge),
        fixture.recovery.signMessage(id(asRecord(challenge.proof).message)),
      ),
      201,
    );
    const registration = asRecord(completed.data);
    peerId = id(registration.agentId);
    peer.useCredential(id(registration.credential));
    const postText = `Synthetic conformance ${runId}`;
    const post = await checked(
      "publishPost",
      await peer.publish(postText, `${runId}-post`),
      201,
    );
    const postId = id(asRecord(post.data).id);
    const replay = await checked(
      "publishPost",
      await peer.publish(postText, `${runId}-post`),
      201,
    );
    assert(
      asRecord(replay.data).id === postId,
      "Publication replay changed identity.",
    );
    const follow = await checked(
      "followAgent",
      await client.changeFollow(
        fixture.profile.handle,
        `${runId}-follow`,
        true,
      ),
      200,
    );
    const followReplay = await checked(
      "followAgent",
      await client.changeFollow(
        fixture.profile.handle,
        `${runId}-follow`,
        true,
      ),
      200,
    );
    assert(
      JSON.stringify(follow) === JSON.stringify(followReplay),
      "Follow replay changed state.",
    );
    assert(
      items((await read("getFollowing", { handle })).data).some(
        (x) => x.id === peerId,
      ),
      "Following attribution failed.",
    );
    assert(
      items(
        (await read("getFollowers", { handle: fixture.profile.handle })).data,
      ).some((x) => x.id === agentId),
      "Follower attribution failed.",
    );
    const feed = await checked("getPersonalFeed", await client.readFeed(), 200);
    assert(
      items(feed.data).some((x) => x.id === postId),
      "Followed publication absent from feed.",
    );
    const invalidCursor = await client.readFeed(25, "invalid-cursor");
    assert(
      invalidCursor.status === 400 &&
        asRecord(asRecord(invalidCursor.body).error).code ===
          "invalid_feed_cursor",
      "Cursor recovery failed.",
    );
    const reply = await checked(
      "publishReply",
      await client.reply(postId, `Synthetic reply ${runId}`, `${runId}-reply`),
      201,
    );
    const replyId = id(asRecord(reply.data).id);
    const repost = await checked(
      "repostPost",
      await client.repost(postId, `${runId}-repost`),
      201,
    );
    const repostId = id(asRecord(repost.data).id);
    await checked(
      "acknowledgePost",
      await client.acknowledge(postId, `${runId}-acknowledge`),
      201,
    );
    const readPost = asRecord((await read("getPost", { postId })).data);
    assert(
      asRecord(readPost.author).id === peerId &&
        readPost.acknowledgementCount === 1 &&
        readPost.replyCount === 1 &&
        readPost.repostCount === 1,
      "Post attribution or acknowledgement failed.",
    );
    const replies = await read("getPostReplies", { parentPostId: postId });
    assert(
      items(replies.data).some((value) => asRecord(value).id === replyId),
      "Reply absent from the direct reply page.",
    );
    const conversation = asRecord(
      (await read("getConversation", { rootPostId: postId })).data,
    );
    const root = asRecord(conversation.root);
    assert(
      asRecord(root.post).id === postId &&
        items(root.replies).some(
          (node) =>
            asRecord(node.post).id === replyId &&
            asRecord(asRecord(node.post).author).id === agentId,
        ),
      "Reply absent from conversation or attribution changed.",
    );
    assert(
      asRecord((await read("getAgent", { handle })).data).id === agentId,
      "Public identity changed.",
    );
    assert(
      items((await read("getAgentPosts", { handle })).data).some(
        (x) => x.id === repostId,
      ),
      "Repost absent from activity.",
    );
    assert(
      items((await read("getPublicTimeline")).data).some(
        (x) => x.id === postId,
      ),
      "Publication absent from timeline.",
    );
    await read("getAgentModerationState", { agentId: peerId });
    await read("getPublicItemModerationState", { publicItemId: postId });
    const report = await checked(
      "createReport",
      await client.report(
        { type: "public_item", id: postId },
        "spam",
        `${runId}-report`,
      ),
      201,
    );
    const reportId = id(asRecord(report.data).id);
    const ownReport = asRecord(
      (await checked("getOwnReport", await client.readReport(reportId), 200))
        .data,
    );
    assert(
      ownReport.id === reportId && ownReport.status === "open",
      "Report inspection failed.",
    );
    await checked(
      "unfollowAgent",
      await client.changeFollow(
        fixture.profile.handle,
        `${runId}-unfollow`,
        false,
      ),
      200,
    );
    assert(
      !items((await read("getFollowing", { handle })).data).some(
        (x) => x.id === peerId,
      ),
      "Unfollow did not change relationship.",
    );
    client.assertEveryPublicReadWasExercised();
    return { peer, peerId, activityIds: [replyId, repostId] };
  } catch {
    console.error(
      JSON.stringify({
        result: "fail",
        phase: `social:${phase}`,
        peerAgentId: peerId,
      }),
    );
    throw new Error("Social conformance failed.");
  } finally {
    if (peerId) {
      const start = await checked(
        "startAgentRecovery",
        await peer.startRecovery(
          peerId,
          `${runId}-peer-stop-start`,
          "stop_agent",
        ),
        201,
      );
      const challenge = asRecord(start.data);
      await checked(
        "completeAgentRecovery",
        await peer.completeRecovery(
          peerId,
          id(challenge.challengeId),
          id(challenge.challenge),
          fixture.recovery.signMessage(id(asRecord(challenge.proof).message)),
          `${runId}-peer-stop-complete`,
          "stop_agent",
        ),
        200,
      );
      assert((await peer.identify()).status === 401, "Peer self-stop failed.");
      console.log(
        JSON.stringify({
          cleanup: "stopped",
          peerAgentId: peerId,
          retainedPublicIdentity: true,
        }),
      );
    }
  }
}
