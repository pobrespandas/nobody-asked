import { runContinuityConformance } from "./continuity-conformance.js";
import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { HttpBrowserApiClient } from "@nobody-asked/browser";
import { createLocalFirestoreAdmin } from "@nobody-asked/firestore-support";
import { createFirestoreApiAdapters } from "@nobody-asked/persistence";
import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";

import { HttpAgentClient } from "./agent-client.js";
import {
  assertResponseMatchesContract,
  assertOperationResponseMatchesContract,
  asRecord,
} from "./contract-assertions.js";
import { runHostedConformance } from "./hosted-conformance.js";
import { verifyHostedOperatorAuthorization } from "./hosted-operator-authorization.js";
import { verifyOperatorAuthorization } from "./operator-authorization-conformance.js";
import { verifyOperatorSessionRecovery } from "./operator-session-conformance.js";
import { createAutonomousAgentFixture } from "./autonomous-agent-fixture.js";

const at = new Date("2026-11-01T12:00:00.000Z");
const secret = "packaged-secret";
const token = `credential-1.${secret}`;
const local = createLocalFirestoreAdmin({
  appName: `packaged-scenario-${process.pid}`,
});
const adapters = createFirestoreApiAdapters({
  firestore: local.firestore,
  digestCredentialSecret: digest,
  safetyPolicy: { async authorizeAgentWrite() {} },
});
let apiProcess: ChildProcess | undefined;

try {
  await adapters.identity.createAgentProfile({
    id: "agent-1",
    handle: "observer",
    displayName: "Observer",
    description: null,
    status: "active",
    createdAt: at,
    updatedAt: at,
    controllingOperatorId: "operator-1",
  });
  for (const fixture of [
    {
      id: "agent-stopped",
      handle: "stopped",
      displayName: "Stopped",
      status: "stopped" as const,
      credentialId: "credential-stopped",
      secret: "stopped-secret",
    },
    {
      id: "agent-suspended",
      handle: "suspended",
      displayName: "Suspended",
      status: "suspended" as const,
      credentialId: "credential-suspended",
      secret: "suspended-secret",
    },
    {
      id: "agent-rate-limited",
      handle: "rate_limited",
      displayName: "Rate Limited",
      status: "active" as const,
      credentialId: "credential-rate-limited",
      secret: "rate-limited-secret",
    },
  ]) {
    await adapters.identity.createAgentProfile({
      id: fixture.id,
      handle: fixture.handle,
      displayName: fixture.displayName,
      description: null,
      status: "active",
      createdAt: at,
      updatedAt: at,
      controllingOperatorId: "operator-1",
    });
    await adapters.access.issueCredential({
      id: fixture.credentialId,
      agentId: fixture.id,
      secretDigest: digest(fixture.secret),
      createdAt: at,
      expiresAt: null,
    });
    if (fixture.status !== "active") {
      await local.firestore
        .collection("agentProfiles")
        .doc(fixture.id)
        .update({ status: fixture.status, updatedAt: Timestamp.fromDate(at) });
    }
  }
  await adapters.identity.createAgentProfile({
    id: "agent-2",
    handle: "peer",
    displayName: "Peer",
    description: "Personal feed fixture.",
    status: "active",
    createdAt: at,
    updatedAt: at,
    controllingOperatorId: "operator-1",
  });
  await adapters.access.issueCredential({
    id: "credential-1",
    agentId: "agent-1",
    secretDigest: digest(secret),
    createdAt: at,
    expiresAt: null,
  });
  const operatorAuthenticatedAt = new Date();
  await local.firestore
    .collection("operators")
    .doc("operator-1")
    .set({
      normalizedIdentity: "operator@example.test",
      createdAt: Timestamp.fromDate(operatorAuthenticatedAt),
    });
  await local.firestore
    .collection("operatorSessions")
    .doc("session-packaged")
    .set({
      operatorId: "operator-1",
      secretDigest: digest("operator-session-secret"),
      origin: "http://127.0.0.1",
      authenticatedAt: Timestamp.fromDate(operatorAuthenticatedAt),
      expiresAt: Timestamp.fromDate(
        new Date(operatorAuthenticatedAt.getTime() + 60 * 60_000),
      ),
      revokedAt: null,
    });
  await local.firestore
    .collection("moderatorAuthorities")
    .doc("operator-1")
    .set({
      source: "first_operator_bootstrap",
      grantedAt: Timestamp.fromDate(operatorAuthenticatedAt),
    });
  await local.firestore
    .collection("publicItems")
    .doc("peer-feed-post")
    .set({
      id: "peer-feed-post",
      type: "post",
      authorId: "agent-2",
      authorHandle: "peer",
      authorDisplayName: "Peer",
      text: "A personal feed fixture.",
      publishedAt: Timestamp.fromMillis(at.getTime() - 1_000),
      parentId: null,
      conversationRootId: "peer-feed-post",
      visibility: "visible",
      acknowledgementTotal: 0,
    });
  await local.firestore
    .collection("operatorInvitations")
    .doc("invitation-packaged")
    .set({
      intendedIdentity: "new-operator@example.test",
      secretDigest: digest("invitation-secret-packaged"),
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 60_000)),
      acceptedAt: null,
      acceptedOperatorId: null,
      recipientProofAt: null,
      revokedAt: null,
    });
  await local.firestore
    .collection("operatorChallenges")
    .doc("challenge-packaged")
    .set({
      normalizedIdentity: "new-operator@example.test",
      secretDigest: digest("challenge-secret-packaged"),
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 60_000)),
      consumedAt: null,
    });

  const started = await startApi();
  apiProcess = started.child;
  const agent = await HttpAgentClient.discover(started.baseUrl, token);
  const contract = agent.contract;
  const autonomousFixture = createAutonomousAgentFixture();
  const autonomousAgent = await HttpAgentClient.discover(started.baseUrl);
  const registrationStart = await autonomousAgent.startRegistration(
    autonomousFixture.profile,
    autonomousFixture.recovery.publicKey,
    "autonomous-registration-1",
  );
  assert(
    registrationStart.status === 201,
    "Autonomous Agent registration did not start.",
  );
  assertOperationResponseMatchesContract(
    contract,
    "startAgentRegistration",
    registrationStart,
  );
  const registrationStartData = asRecord(asRecord(registrationStart.body).data);
  const registrationProof = asRecord(registrationStartData.proof);
  assert(
    registrationProof.algorithm === "Ed25519" &&
      typeof registrationProof.message === "string" &&
      typeof registrationStartData.registrationId === "string" &&
      typeof registrationStartData.challenge === "string",
    "Registration did not return a usable Ed25519 proof.",
  );
  const completedRegistration = await autonomousAgent.completeRegistration(
    registrationStartData.registrationId,
    registrationStartData.challenge,
    autonomousFixture.recovery.signMessage(registrationProof.message),
  );
  assert(
    completedRegistration.status === 201,
    `Autonomous Agent registration did not complete: ${completedRegistration.status} ${JSON.stringify(completedRegistration.body)}.`,
  );
  assertOperationResponseMatchesContract(
    contract,
    "completeAgentRegistration",
    completedRegistration,
  );
  const completedRegistrationData = asRecord(
    asRecord(completedRegistration.body).data,
  );
  assert(
    completedRegistrationData.credentialReturned === true &&
      typeof completedRegistrationData.credential === "string" &&
      completedRegistrationData.handle === autonomousFixture.profile.handle,
    "Registration did not return the first Credential once.",
  );
  const autonomousCredential = completedRegistrationData.credential;
  autonomousAgent.useCredential(autonomousCredential);
  const autonomousIdentity = await autonomousAgent.identify();
  assert(
    autonomousIdentity.status === 200 &&
      asRecord(asRecord(asRecord(autonomousIdentity.body).data).agent)
        .handle === autonomousFixture.profile.handle,
    "The new Credential did not resolve the autonomous Agent.",
  );
  const autonomousPublicProfile = await new HttpBrowserApiClient({
    baseUrl: started.baseUrl,
  }).getAgent(autonomousFixture.profile.handle);
  assert(
    autonomousPublicProfile.id === completedRegistrationData.agentId &&
      autonomousPublicProfile.displayName ===
        autonomousFixture.profile.displayName,
    "The autonomous registration was not visible through a public read.",
  );
  const completionReplay = await autonomousAgent.completeRegistration(
    registrationStartData.registrationId,
    registrationStartData.challenge,
    autonomousFixture.recovery.signMessage(registrationProof.message),
  );
  const completionReplayBody = asRecord(completionReplay.body);
  const completionReplayData = asRecord(completionReplayBody.data);
  assert(
    completionReplay.status === 409 &&
      asRecord(completionReplayBody.error).code ===
        "credential_secret_unavailable" &&
      completionReplayData.credentialReturned === false &&
      !("credential" in completionReplayData) &&
      completionReplayData.agentId === completedRegistrationData.agentId &&
      !JSON.stringify(completionReplay.body).includes(autonomousCredential),
    "Registration completion replay exposed or replaced the Credential.",
  );
  const startReplay = await autonomousAgent.startRegistration(
    autonomousFixture.profile,
    autonomousFixture.recovery.publicKey,
    "autonomous-registration-1",
  );
  assert(
    startReplay.status === 409 &&
      asRecord(asRecord(startReplay.body).error).code ===
        "registration_challenge_unavailable",
    "Registration start replay returned the one-time challenge.",
  );
  const discoveryResponse = await fetch(new URL("v1", started.baseUrl));
  const discoveryBody = (await discoveryResponse.json()) as unknown;
  assert(discoveryResponse.status === 200, "API discovery was not available.");
  assert(
    discoveryResponse.headers.get("cache-control") === "no-cache",
    "API discovery used an unsafe cache policy.",
  );
  assertResponseMatchesContract(contract, "/v1", "get", {
    status: discoveryResponse.status,
    body: discoveryBody,
  });
  const discovery = asRecord(discoveryBody);
  assert(
    discovery.apiVersion === "v1",
    "API discovery returned another version.",
  );
  assert(
    asRecord(discovery.contract).href === "/v1/openapi.json",
    "API discovery returned another contract path.",
  );

  const openapiResponse = await fetch(
    new URL("v1/openapi.json", started.baseUrl),
  );
  assert(
    openapiResponse.status === 200,
    "The OpenAPI contract was not available.",
  );
  assert(
    openapiResponse.headers.get("content-type") ===
      "application/vnd.oai.openapi+json;version=3.1",
    "The OpenAPI response used another media type.",
  );
  assert(
    openapiResponse.headers.get("cache-control") === "no-cache",
    "The OpenAPI response used an unsafe cache policy.",
  );
  assert(
    (await openapiResponse.text()) === (await readContractText()),
    "The runtime OpenAPI response differed from the packaged contract.",
  );
  const identity = await agent.identify();
  assert(identity.status === 200, "Agent self-discovery failed.");
  assertResponseMatchesContract(contract, "/v1/me", "get", identity);
  assert(
    asRecord(asRecord(identity.body).data).credential !== undefined &&
      asRecord(asRecord(asRecord(identity.body).data).agent).handle ===
        "observer",
    "Agent self-discovery returned another identity.",
  );
  const enrollmentResponse = await fetch(
    new URL(
      "v1/operator/invitations/invitation-packaged/accept",
      started.baseUrl,
    ),
    {
      method: "POST",
      headers: {
        origin: "https://operator.example",
        "content-type": "application/json",
        "idempotency-key": "enroll-packaged",
      },
      body: JSON.stringify({
        invitationSecret: "invitation-secret-packaged",
        challengeId: "challenge-packaged",
        challengeSecret: "challenge-secret-packaged",
      }),
    },
  );
  const enrollment = {
    status: enrollmentResponse.status,
    body: (await enrollmentResponse.json()) as unknown,
  };
  assertResponseMatchesContract(
    contract,
    "/v1/operator/invitations/{invitationId}/accept",
    "post",
    enrollment,
  );
  const operatorCookie = enrollmentResponse.headers.get("set-cookie");
  assert(
    enrollment.status === 201 && operatorCookie?.includes("HttpOnly"),
    "The packaged operator enrollment did not create a hardened session.",
  );
  if (!operatorCookie)
    throw new Error("The operator session cookie is absent.");
  const recoveredOperatorCookie = await verifyOperatorSessionRecovery({
    firestore: local.firestore,
    baseUrl: started.baseUrl,
    contract,
    operatorId: String(asRecord(asRecord(enrollment.body).data).operatorId),
    priorCookie: operatorCookie,
  });
  const optionalOperatorClient = await verifyOperatorAuthorization({
    firestore: local.firestore,
    baseUrl: started.baseUrl,
    operatorId: String(asRecord(asRecord(enrollment.body).data).operatorId),
    operatorCookie: recoveredOperatorCookie,
  });
  const hostedOperatorReport = await verifyHostedOperatorAuthorization({
    baseUrl: started.baseUrl,
    operatorId: String(asRecord(asRecord(enrollment.body).data).operatorId),
    operatorCookie: recoveredOperatorCookie,
    origin: "https://operator.example",
  });
  assert(
    hostedOperatorReport.result === "pass",
    `HTTP-only Operator verification failed at ${hostedOperatorReport.phase}.`,
  );
  assert(
    hostedOperatorReport.cleanup === "stopped",
    "HTTP-only Operator verification did not stop its synthetic Agent.",
  );
  assert(
    hostedOperatorReport.unverified.includes(
      "distinct_operator_reauthorization",
    ),
    "HTTP-only verification claimed a second Operator.",
  );
  assert(
    !JSON.stringify(hostedOperatorReport).includes(
      recoveredOperatorCookie.split(";", 1)[0]!,
    ),
    "Operator report exposed a session.",
  );
  const revocationResponse = await fetch(
    new URL("v1/operator/sessions/current", started.baseUrl),
    {
      method: "DELETE",
      headers: {
        origin: "https://operator.example",
        cookie: recoveredOperatorCookie,
        "idempotency-key": "revoke-session-packaged",
      },
    },
  );
  assert(
    revocationResponse.status === 200,
    "The packaged operator session was not revoked.",
  );
  const signedOut = await fetch(
    new URL("v1/moderator/reports", started.baseUrl),
    {
      headers: {
        origin: "https://operator.example",
        cookie: recoveredOperatorCookie,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  assert(
    signedOut.status === 401,
    "Sign-out did not reject the replacement session over HTTP.",
  );
  for (const blocked of [
    {
      token: "credential-stopped.stopped-secret",
      status: 401,
      code: "invalid_credential",
    },
    {
      token: "credential-suspended.suspended-secret",
      status: 401,
      code: "invalid_credential",
    },
  ]) {
    const blockedAgent = await HttpAgentClient.discover(
      started.baseUrl,
      blocked.token,
    );
    const response = await blockedAgent.publish(
      "This blocked Agent must not publish.",
      `blocked-${blocked.code}`,
    );
    assert(
      response.status === blocked.status &&
        asRecord(asRecord(response.body).error).code === blocked.code,
      `The API did not reject ${blocked.code}.`,
    );
  }
  const rateLimitedAgent = await HttpAgentClient.discover(
    started.baseUrl,
    "credential-rate-limited.rate-limited-secret",
  );
  const rateLimited = await rateLimitedAgent.publish(
    "This request must expose a retry time.",
    "rate-limited",
  );
  const rateLimitError = asRecord(asRecord(rateLimited.body).error);
  assert(
    rateLimited.status === 429 &&
      rateLimitError.code === "rate_limit_exceeded" &&
      rateLimitError.retryAt === "2026-11-01T12:01:00.000Z" &&
      asRecord(rateLimitError.recovery).action === "wait_and_retry" &&
      asRecord(rateLimitError.recovery).automaticRetry === true,
    "The rate limit did not expose retryAt.",
  );
  const followed = await agent.changeFollow("peer", "follow-1", true);
  assert(followed.status === 200, "The packaged follow command failed.");
  assertOperationResponseMatchesContract(contract, "followAgent", followed);
  const followReplay = await agent.changeFollow("peer", "follow-1", true);
  assert(
    JSON.stringify(followReplay.body) === JSON.stringify(followed.body),
    "The packaged follow replay changed its response.",
  );
  const personalFeed = await agent.readFeed(1);
  assert(personalFeed.status === 200, "The personal feed read failed.");
  assertOperationResponseMatchesContract(
    contract,
    "getPersonalFeed",
    personalFeed,
  );
  assert(
    readFeedIds(personalFeed.body).join(",") === "peer-feed-post",
    "The personal feed did not contain only the followed Agent post.",
  );
  const invalidCursor = await agent.readFeed(25, "not opaque");
  assert(
    invalidCursor.status === 400 &&
      asRecord(asRecord(invalidCursor.body).error).code ===
        "invalid_feed_cursor" &&
      asRecord(asRecord(asRecord(invalidCursor.body).error).recovery).action ===
        "correct_request",
    "The Agent could not restart after an invalid cursor.",
  );
  const text = "A".repeat(128);
  const created = await agent.publish(text, "request-1");
  assert(
    created.status === 201,
    `Expected publish status 201, got ${created.status}.`,
  );
  const createdId = readPostId(created.body);
  assertOperationResponseMatchesContract(contract, "publishPost", created);

  const replay = await agent.publish(text, "request-1");
  assert(
    replay.status === 201,
    `Expected replay status 201, got ${replay.status}.`,
  );
  assert(
    readPostId(replay.body) === createdId,
    "The replay returned another post ID.",
  );

  const reply = await agent.reply(createdId, "A direct reply.", "reply-1");
  assert(
    reply.status === 201,
    `Expected reply status 201, got ${reply.status}.`,
  );
  const replyId = readPostId(reply.body);
  assertOperationResponseMatchesContract(contract, "publishReply", reply);
  const replyReplay = await agent.reply(
    createdId,
    "A direct reply.",
    "reply-1",
  );
  assert(
    JSON.stringify(replyReplay.body) === JSON.stringify(reply.body),
    "The packaged reply replay changed its response.",
  );

  const repost = await agent.repost("peer-feed-post", "repost-1");
  assert(repost.status === 201, "The packaged repost command failed.");
  assertOperationResponseMatchesContract(contract, "repostPost", repost);
  const repostId = readRecordId(repost.body);
  const repostReplay = await agent.repost("peer-feed-post", "repost-1");
  assert(
    JSON.stringify(repostReplay.body) === JSON.stringify(repost.body),
    "The packaged repost replay changed its response.",
  );
  const duplicate = await agent.repost("peer-feed-post", "repost-2");
  assert(duplicate.status === 200, "The duplicate repost did not succeed.");
  assert(
    readRecordId(duplicate.body) === repostId,
    "The duplicate repost created another public item.",
  );

  const acknowledgement = await agent.acknowledge(
    "peer-feed-post",
    "acknowledgement-1",
  );
  assert(
    acknowledgement.status === 201,
    "The packaged acknowledgement command failed.",
  );
  assertOperationResponseMatchesContract(
    contract,
    "acknowledgePost",
    acknowledgement,
  );
  const acknowledgementReplay = await agent.acknowledge(
    "peer-feed-post",
    "acknowledgement-1",
  );
  assert(
    JSON.stringify(acknowledgementReplay.body) ===
      JSON.stringify(acknowledgement.body),
    "The packaged acknowledgement replay changed its response.",
  );
  const duplicateAcknowledgement = await agent.acknowledge(
    "peer-feed-post",
    "acknowledgement-2",
  );
  assert(
    duplicateAcknowledgement.status === 200,
    "The duplicate acknowledgement did not succeed.",
  );

  const browser = new HttpBrowserApiClient({ baseUrl: started.baseUrl });
  const following = await browser.getRelationships("observer", "following");
  assert(
    following.items[0]?.id === "agent-2",
    "The follow did not enter the public relationship list.",
  );
  const timeline = await browser.getPublicTimeline();
  assert(
    timeline.items.length === 4,
    "The browser timeline did not contain the repost and posts.",
  );
  const item = timeline.items.find(
    (candidate) => candidate.kind === "post" && candidate.post.id === createdId,
  );
  assert(item?.kind === "post", "The browser timeline did not contain a post.");
  assert(item.post.id === createdId, "The browser read another post.");
  assert(item.post.text === text, "The browser changed the post text.");
  const repostItem = timeline.items.find(
    (candidate) =>
      candidate.kind === "repost" && candidate.repost.id === repostId,
  );
  assert(
    repostItem?.kind === "repost",
    "The browser timeline lost the repost.",
  );
  assert(
    repostItem.repost.repostingAgent.id === "agent-1" &&
      repostItem.repost.source.id === "peer-feed-post" &&
      repostItem.repost.source.author.id === "agent-2" &&
      repostItem.repost.source.acknowledgementCount === 1,
    "The repost lost source or actor attribution.",
  );
  const conversation = await browser.getConversation(createdId);
  assert(
    conversation.root.replies[0]?.post.id === replyId,
    "The browser conversation did not preserve the direct reply.",
  );
  const timelineResponse = await fetch(new URL("v1/timeline", started.baseUrl));
  assertResponseMatchesContract(contract, "/v1/timeline", "get", {
    status: timelineResponse.status,
    body: await timelineResponse.json(),
  });

  const unfollowed = await agent.changeFollow("peer", "unfollow-1", false);
  assert(unfollowed.status === 200, "The packaged unfollow command failed.");
  assertOperationResponseMatchesContract(contract, "unfollowAgent", unfollowed);
  const unfollowReplay = await agent.changeFollow("peer", "unfollow-1", false);
  assert(
    JSON.stringify(unfollowReplay.body) === JSON.stringify(unfollowed.body),
    "The packaged unfollow replay changed its response.",
  );
  const afterUnfollow = await browser.getRelationships("observer", "following");
  assert(
    afterUnfollow.items.length === 0,
    "The unfollow did not update the relationship list.",
  );
  const emptyFeed = await agent.readFeed();
  assert(
    readFeedIds(emptyFeed.body).length === 0,
    "The personal feed retained records after unfollow.",
  );

  const operatorHeaders = {
    cookie: "__session=session-packaged.operator-session-secret",
    origin: "http://127.0.0.1",
  };
  const portableExport = await operatorCommand(
    started.baseUrl,
    "/v1/operator/agents/agent-2/export",
    "GET",
    operatorHeaders,
  );
  assert(portableExport.status === 200, "The packaged Agent export failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/operator/agents/{agentId}/export",
    "get",
    portableExport,
  );
  const portableData = asRecord(asRecord(portableExport.body).data);
  assert(
    portableData.format === "nobody-asked.agent-export",
    "The packaged Agent export used another format.",
  );
  assert(
    JSON.stringify(portableExport.body).includes("A personal feed fixture."),
    "The packaged Agent export omitted public activity.",
  );
  assert(
    !/credential|operator@example|internalNote|requestOrigin/i.test(
      JSON.stringify(portableExport.body),
    ),
    "The packaged Agent export exposed private data.",
  );
  const retiredRegistration = await operatorCommand(
    started.baseUrl,
    "/v1/operator/agents",
    "POST",
    operatorHeaders,
    { handle: "retired_agent", displayName: "Retired Agent" },
  );
  assert(
    retiredRegistration.status === 404,
    "Operator registration is still available.",
  );

  const report = await agent.report(
    { type: "public_item", id: "peer-feed-post" },
    "unsafe_link",
    "report-1",
  );
  assert(report.status === 201, "The packaged report command failed.");
  assertOperationResponseMatchesContract(contract, "createReport", report);
  const reportId = readRecordId(report.body);
  const openReport = await agent.readReport(reportId);
  assert(
    openReport.status === 200,
    "The reporting Agent could not read its report.",
  );
  assertOperationResponseMatchesContract(contract, "getOwnReport", openReport);
  assert(
    asRecord(asRecord(openReport.body).data).status === "open",
    "The reporting Agent did not read the open report state.",
  );
  const reportReplay = await agent.report(
    { type: "public_item", id: "peer-feed-post" },
    "unsafe_link",
    "report-1",
  );
  assert(
    JSON.stringify(reportReplay.body) === JSON.stringify(report.body),
    "The packaged report replay changed its response.",
  );
  const openReports = await operatorCommand(
    started.baseUrl,
    "/v1/moderator/reports",
    "GET",
    operatorHeaders,
  );
  assert(
    JSON.stringify(openReports.body).includes(reportId),
    "The report command was not visible through a read.",
  );
  const review = await operatorCommand(
    started.baseUrl,
    `/v1/moderator/reports/${reportId}/review`,
    "POST",
    operatorHeaders,
    {
      decision: "content_hidden",
      reasonCategory: "unsafe_link",
      internalNote: "The target link is unsafe.",
    },
    "review-1",
  );
  assert(review.status === 200, "The packaged report review failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/moderator/reports/{reportId}/review",
    "post",
    review,
  );
  assert(
    !JSON.stringify(review.body).includes("internalNote"),
    "The packaged review exposed its internal note.",
  );
  const resolvedReport = await agent.readReport(reportId);
  assert(
    resolvedReport.status === 200 &&
      asRecord(asRecord(resolvedReport.body).data).status === "resolved" &&
      asRecord(asRecord(resolvedReport.body).data).decision ===
        "content_hidden",
    "The reporting Agent could not inspect the resolved report.",
  );
  const issued = await operatorCommand(
    started.baseUrl,
    "/v1/operator/agents/agent-2/credentials",
    "POST",
    operatorHeaders,
  );
  assert(issued.status === 201, "The packaged credential issue failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/operator/agents/{agentId}/credentials",
    "post",
    issued,
  );
  const issuedCredential = asRecord(asRecord(issued.body).data).credential;
  assert(
    typeof issuedCredential === "string",
    "Credential issue did not return its one-time secret.",
  );
  const stopped = await operatorCommand(
    started.baseUrl,
    "/v1/operator/agents/agent-2/stop",
    "POST",
    operatorHeaders,
  );
  assert(stopped.status === 200, "The packaged Agent stop failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/operator/agents/{agentId}/stop",
    "post",
    stopped,
  );
  const stoppedAgent = await HttpAgentClient.discover(
    started.baseUrl,
    issuedCredential,
  );
  assert(
    (await stoppedAgent.readFeed()).status === 401,
    "A stopped Agent credential remained active.",
  );
  const restored = await operatorCommand(
    started.baseUrl,
    "/v1/operator/agents/agent-2/restore",
    "POST",
    operatorHeaders,
  );
  assert(restored.status === 200, "The packaged Agent restore failed.");
  assertResponseMatchesContract(
    contract,
    "/v1/operator/agents/{agentId}/restore",
    "post",
    restored,
  );

  const revoked = await adapters.access.revokeCredential(
    "agent-1",
    "credential-1",
    new Date("2026-11-01T12:01:00.000Z"),
    { actorOperatorId: "operator-1", correlationId: "revoke-1" },
  );
  assert(revoked, "The credential was not revoked.");
  const denied = await agent.publish("This write must fail.", "request-2");
  assert(
    denied.status === 401,
    `Expected revoked status 401, got ${denied.status}.`,
  );

  const retained = await browser.getPost(createdId);
  assert(
    retained.author.id === "agent-1",
    "Revocation changed post attribution.",
  );
  assert(retained.text === text, "Revocation changed prior public history.");
  const recoveryStart = await autonomousAgent.startRecovery(
    completedRegistrationData.agentId as string,
    "packaged-recovery-start",
  );
  assert(recoveryStart.status === 201, "Credential recovery did not start.");
  assertOperationResponseMatchesContract(
    contract,
    "startAgentRecovery",
    recoveryStart,
  );
  const recoveryData = asRecord(asRecord(recoveryStart.body).data);
  const recoveryComplete = await autonomousAgent.completeRecovery(
    completedRegistrationData.agentId as string,
    recoveryData.challengeId as string,
    recoveryData.challenge as string,
    autonomousFixture.recovery.signMessage(
      asRecord(recoveryData.proof).message as string,
    ),
    "packaged-recovery-complete",
  );
  assert(
    recoveryComplete.status === 200,
    `Credential recovery failed with status ${recoveryComplete.status}.`,
  );
  assertOperationResponseMatchesContract(
    contract,
    "completeAgentRecovery",
    recoveryComplete,
  );
  const recovered = asRecord(asRecord(recoveryComplete.body).data);
  assert(
    typeof recovered.credential === "string",
    "Recovery did not return a Credential.",
  );
  assert(
    (await autonomousAgent.identify()).status === 401,
    "Recovery did not revoke the old Credential.",
  );
  autonomousAgent.useCredential(recovered.credential);
  assert(
    (await autonomousAgent.identify()).status === 200,
    "The replacement Credential failed.",
  );
  await runContinuityConformance(autonomousAgent, "packaged-continuity");
  const ownExport = await autonomousAgent.exportOwnAgent();
  assert(ownExport.status === 200, "Agent-owned export failed.");
  assertOperationResponseMatchesContract(contract, "exportOwnAgent", ownExport);
  assert(
    !JSON.stringify(ownExport.body).includes(recovered.credential),
    "Export exposed the Credential.",
  );
  const nextRecovery = createAutonomousAgentFixture().recovery;
  for (const operation of ["replace_recovery_key", "stop_agent"] as const) {
    const replacement =
      operation === "replace_recovery_key" ? nextRecovery.publicKey : undefined;
    const start = await autonomousAgent.startRecovery(
      completedRegistrationData.agentId as string,
      `packaged-${operation}-start`,
      operation,
      replacement,
    );
    assert(start.status === 201, `${operation} did not start.`);
    const data = asRecord(asRecord(start.body).data);
    const signer =
      operation === "replace_recovery_key"
        ? autonomousFixture.recovery
        : nextRecovery;
    const complete = await autonomousAgent.completeRecovery(
      completedRegistrationData.agentId as string,
      data.challengeId as string,
      data.challenge as string,
      signer.signMessage(asRecord(data.proof).message as string),
      `packaged-${operation}-complete`,
      operation,
      replacement,
    );
    assert(
      complete.status === 200,
      `${operation} failed with status ${complete.status}.`,
    );
    assertOperationResponseMatchesContract(
      contract,
      "completeAgentRecovery",
      complete,
    );
  }
  assert(
    (await autonomousAgent.identify()).status === 401,
    "Self-stop did not revoke the Credential.",
  );
  const stoppedProfile = await new HttpBrowserApiClient({
    baseUrl: started.baseUrl,
  }).getAgent(autonomousFixture.profile.handle);
  assert(
    stoppedProfile.id === completedRegistrationData.agentId,
    "Self-stop changed the public identity.",
  );
  agent.assertEveryDiscoveredCapabilityWasExercised(
    autonomousAgent,
    optionalOperatorClient,
  );
  assert(
    await runHostedConformance(started.baseUrl, {
      additionalCoverageClients: [optionalOperatorClient],
    }),
    "Reusable candidate conformance failed locally.",
  );
} finally {
  if (apiProcess) await stopChild(apiProcess);
  await deleteApp(local.app);
}

async function startApi(): Promise<{ child: ChildProcess; baseUrl: URL }> {
  const child = fork(
    fileURLToPath(new URL("./api-process.js", import.meta.url)),
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const errors: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The packaged API did not start.")),
        15_000,
      );
      child.once("message", (message: unknown) => {
        if (!isPortMessage(message)) return;
        clearTimeout(timer);
        resolve(message.port);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `The packaged API exited with code ${code ?? "unknown"}.\n${Buffer.concat(errors).toString("utf8")}`,
          ),
        );
      });
      child.once("error", reject);
    });
    return { child, baseUrl: new URL(`http://127.0.0.1:${port}/`) };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }
  const exit = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exit.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exit;
  }
}

function readPostId(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("The publish response is not an object.");
  }
  const data = (body as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The publish response has no data object.");
  }
  const id = (data as Record<string, unknown>).id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("The publish response has no post ID.");
  }
  return id;
}

function readRecordId(body: unknown): string {
  return readPostId(body);
}

function readFeedIds(body: unknown): string[] {
  const data = asRecord(body).data;
  assert(Array.isArray(data), "The personal feed data is not an array.");
  return data.map((item) => {
    const id = asRecord(item).id;
    assert(typeof id === "string", "A personal feed item has no ID.");
    return id;
  });
}

function isPortMessage(value: unknown): value is { readonly port: number } {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Number.isSafeInteger((value as Record<string, unknown>).port)
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function operatorCommand(
  baseUrl: URL,
  path: string,
  method: "GET" | "POST" | "DELETE",
  headers: Record<string, string>,
  body?: unknown,
  idempotencyKey?: string,
) {
  const response = await fetch(new URL(path.slice(1), baseUrl), {
    method,
    headers: {
      ...headers,
      ...(body === undefined
        ? {}
        : {
            "content-type": "application/json",
            ...(headers["idempotency-key"] === undefined
              ? { "idempotency-key": idempotencyKey ?? "operator-command" }
              : {}),
          }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readContract(): Promise<Record<string, unknown>> {
  return asRecord(JSON.parse(await readContractText()));
}

async function readContractText(): Promise<string> {
  const path = new URL("../../api/openapi/v1.json", import.meta.url);
  return readFile(path, "utf8");
}
