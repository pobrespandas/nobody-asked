import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { bootstrapAdministrator } from "./bootstrap-administrator.js";
import { inspectRecoveryIntegrity } from "../packages/firestore-support/src/remote-recovery-verify.js";

const projectId = "gen-lang-client-0607406471";
const databaseId = "nobody-asked-admin-drill-20261110";
if (process.env.FIRESTORE_EMULATOR_HOST)
  throw new Error("Use the explicitly isolated hosted drill.");
const app = initializeApp({ projectId, credential: applicationDefault() });
try {
  const target = getFirestore(app, databaseId);
  if ((await target.listCollections()).length)
    throw new Error(
      "The isolated drill database must be empty. Preserve existing test state.",
    );
  const source = getFirestore(app, "nobody-asked-drill-20261108");
  if ((await inspectRecoveryIntegrity(source)).status !== "integrity_checked")
    throw new Error("The synthetic source lacks evidence.");
  const owner = JSON.parse(
    await readFile(
      join(homedir(), ".config/nobody-asked/admin-bootstrap-target.json"),
      "utf8",
    ),
  );
  if (owner.projectId !== projectId || owner.databaseId !== "nobody-asked-dev")
    throw new Error("Unexpected owner identity source.");
  const identitySource = getFirestore(app, "nobody-asked-dev");
  const [operator, authority, bindings] = await Promise.all([
    identitySource.collection("operators").doc(owner.operatorId).get(),
    identitySource
      .collection("administratorAuthorities")
      .doc(owner.operatorId)
      .get(),
    identitySource
      .collection("administratorBindings")
      .where("operatorId", "==", owner.operatorId)
      .get(),
  ]);
  const binding = bindings.docs[0]?.data();
  if (
    !operator.exists ||
    operator.data()?.active === false ||
    operator.data()?.revokedAt ||
    operator.data()?.disabledAt ||
    !authority.exists ||
    authority.data()?.revokedAt ||
    bindings.size !== 1 ||
    binding?.revokedAt ||
    binding?.issuer !== "https://accounts.google.com" ||
    !binding?.subject
  )
    throw new Error("The existing owner authority could not be confirmed.");
  const at = Timestamp.now(),
    later = Timestamp.fromMillis(Date.now() + 86400000);
  const batch = target.batch();
  for (const collection of await source.listCollections()) {
    for (const record of (await collection.get()).docs)
      batch.create(target.doc(record.ref.path), record.data());
  }
  for (let index = 0; index < 203; index++) {
    const id = `drill-bulk-${String(index).padStart(3, "0")}`;
    batch.create(target.collection("publicItems").doc(id), {
      id,
      type: "post",
      authorId: "drill-one",
      authorHandle: "drill_one",
      authorDisplayName: "Synthetic One",
      text: `Disposable hosted deletion fixture ${index}.`,
      parentId: null,
      conversationRootId: id,
      visibility: "visible",
      publishedAt: at,
    });
  }
  const fixtures: Record<string, Record<string, unknown>> = {
    "operators/drill-administrator": {
      normalizedIdentity: operator.data()!.normalizedIdentity,
      active: true,
      createdAt: at,
    },
    "agentProfiles/drill-ui": {
      handle: "drill_ui",
      displayName: "ISOLATED UI fixture",
      description: "Synthetic hosted administration test only.",
      status: "active",
      createdAt: at,
      updatedAt: at,
    },
    "credentials/drill-ui-credential": {
      agentId: "drill-ui",
      secretDigest: "nonfunctional-synthetic-digest",
      createdAt: at,
      revokedAt: null,
    },
    "agentAccess/drill-ui": { activeCredentialId: "drill-ui-credential" },
    "handleClaims/drill_ui": { agentId: "drill-ui" },
    "operatorSessions/drill-ordinary-session": {
      operatorId: "drill-operator",
      secretDigest: "nonfunctional-synthetic-digest",
      origin:
        "https://admin-preview---nobody-asked-api-b747s3o2ta-uc.a.run.app",
      authenticatedAt: at,
      expiresAt: later,
      revokedAt: null,
    },
    "operatorInvitations/drill-invitation": {
      intendedIdentity: "synthetic@example.invalid",
      secretDigest: "nonfunctional-synthetic-digest",
      issuedAt: at,
      expiresAt: later,
      acceptedAt: null,
      revokedAt: null,
    },
    "agentOperatorAuthorizations/drill-authorization": {
      agentId: "drill-one",
      operatorId: "drill-operator",
      revision: 1,
      requesterCredentialId: "drill-credential",
      requestedAt: at,
      expiresAt: later,
      acceptedAt: at,
      revokedAt: null,
    },
    "agentOperatorAuthority/drill-one": {
      agentId: "drill-one",
      revision: 1,
      pendingAuthorizationId: null,
      activeAuthorizationId: "drill-authorization",
      operatorId: "drill-operator",
      updatedAt: at,
    },
    "reports/drill-report-dismiss": {
      target: { type: "public_item", id: "drill-bulk-000" },
      reportingAgentId: "drill-two",
      reasonCategory: "spam",
      reportedAt: at,
      resolvedAt: null,
    },
    "reports/drill-report-hide": {
      target: { type: "public_item", id: "drill-bulk-001" },
      reportingAgentId: "drill-two",
      reasonCategory: "spam",
      reportedAt: at,
      resolvedAt: null,
    },
  };
  for (const [path, data] of Object.entries(fixtures))
    batch.create(target.doc(path), data);
  await batch.commit();
  await bootstrapAdministrator(target, {
    operatorId: "drill-administrator",
    subject: binding.subject,
    verifiedEmail: operator.data()!.normalizedIdentity,
  });
  const inspection = await inspectRecoveryIntegrity(target);
  if (inspection.status !== "integrity_checked")
    throw new Error("The hosted fixtures did not pass reference checks.");
  console.log(
    JSON.stringify({
      databaseId,
      ownDeletionPosts: 205,
      foreignReply: "drill-reply",
      fixtures: "synthetic-only",
      references: inspection.references,
    }),
  );
} catch {
  console.error(
    "Hosted drill seeding failed. Preserve the database and inspect its state. No private identity is logged.",
  );
  process.exitCode = 1;
} finally {
  await deleteApp(app);
}
