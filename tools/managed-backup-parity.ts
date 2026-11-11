import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import {
  getFirestore,
  Timestamp,
  type Firestore,
} from "firebase-admin/firestore";
import { inspectRecoveryIntegrity } from "../packages/firestore-support/src/remote-recovery-verify.js";

const projectId = "gen-lang-client-0607406471";
const sourceId = "nobody-asked-drill-20261108";
const restoredId = "nobody-asked-recovery-drill-20261108";
const [mode, manifestPath] = process.argv.slice(2);
if (
  !manifestPath ||
  !["seed", "capture", "verify"].includes(mode ?? "") ||
  process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error(
    "Select seed, capture, or verify and a protected manifest path.",
  );
const app = initializeApp({ projectId, credential: applicationDefault() });
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
async function fingerprint(db: Firestore) {
  const inventory: Record<string, { count: number; sha256: string }> = {};
  for (const collection of (await db.listCollections()).sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const snapshot = await collection.get();
    const records = snapshot.docs
      .map((doc) => ({ id: doc.id, data: doc.data() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    inventory[collection.id] = {
      count: snapshot.size,
      sha256: createHash("sha256")
        .update(JSON.stringify(canonical(records)))
        .digest("hex"),
    };
  }
  return inventory;
}
try {
  const source = getFirestore(app, sourceId);
  if (mode === "seed") {
    if ((await source.listCollections()).length)
      throw new Error(
        "The synthetic source must be empty. Seeding will not overwrite records.",
      );
    const stamp = new Timestamp(1794139200, 123456789);
    const records: Record<string, Record<string, unknown>> = {
      "agentProfiles/drill-one": {
        handle: "drill_one",
        displayName: "Synthetic One",
        status: "active",
        createdAt: stamp,
        updatedAt: stamp,
      },
      "agentProfiles/drill-two": {
        handle: "drill_two",
        displayName: "Synthetic Two",
        status: "stopped",
        createdAt: stamp,
        updatedAt: stamp,
      },
      "operators/drill-operator": { active: true },
      "credentials/drill-credential": {
        agentId: "drill-one",
        secretDigest: "synthetic-nonfunctional-digest",
        createdAt: stamp,
      },
      "agentAccess/drill-one": { activeCredentialId: "drill-credential" },
      "handleClaims/drill_one": { agentId: "drill-one" },
      "handleClaims/drill_two": { agentId: "drill-two" },
      "publicItems/drill-root": {
        id: "drill-root",
        type: "post",
        authorId: "drill-one",
        text: "Synthetic backup root.",
        parentId: null,
        conversationRootId: "drill-root",
        visibility: "visible",
        publishedAt: stamp,
        acknowledgementTotal: 1,
      },
      "publicItems/drill-reply": {
        id: "drill-reply",
        type: "reply",
        authorId: "drill-two",
        text: "Synthetic backup reply.",
        parentId: "drill-root",
        conversationRootId: "drill-root",
        visibility: "visible",
        publishedAt: stamp,
      },
      "publicItems/drill-hidden": {
        id: "drill-hidden",
        type: "post",
        authorId: "drill-one",
        text: "Synthetic hidden evidence.",
        parentId: null,
        conversationRootId: "drill-hidden",
        visibility: "hidden",
        publishedAt: stamp,
      },
      "follows/drill-follow": {
        followerId: "drill-one",
        followedId: "drill-two",
        followedAt: stamp,
      },
      "acknowledgements/drill-ack": {
        agentId: "drill-two",
        postId: "drill-root",
        acknowledgedAt: stamp,
      },
      "moderationActions/drill-hidden": {
        subjectType: "public_item",
        subjectId: "drill-hidden",
        reasonCategory: "spam",
        actionAt: stamp,
      },
      "idempotencyRecords/drill-publish": {
        agentId: "drill-one",
        command: "post.publish",
        keyHash: "synthetic-hash",
        response: { status: 201, body: { data: { id: "drill-root" } } },
      },
      "auditRecords/drill-published": {
        actorId: "drill-one",
        action: "post.published",
        subjectType: "public_item",
        subjectId: "drill-root",
        createdAt: stamp,
      },
      "auditRecords/drill-hidden": {
        actorId: "drill-operator",
        actorType: "moderator",
        action: "content.hidden",
        subjectType: "public_item",
        subjectId: "drill-hidden",
        createdAt: stamp,
        details: { reasonCategory: "spam" },
      },
    };
    const batch = source.batch();
    for (const [path, data] of Object.entries(records))
      batch.create(source.doc(path), data);
    await batch.commit();
  }
  const inspection = await inspectRecoveryIntegrity(source);
  if (inspection.status !== "integrity_checked")
    throw new Error("The synthetic source lacks required evidence.");
  const inventory = await fingerprint(source);
  if (mode !== "verify") {
    const manifest = {
      formatVersion: 1,
      projectId,
      sourceId,
      restoredId,
      capturedAt: new Date().toISOString(),
      inventory,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        status: "source_frozen",
        sourceId,
        restoredId,
        documentCount: Object.values(inventory).reduce(
          (n, c) => n + c.count,
          0,
        ),
        acknowledgements: inventory.acknowledgements?.count,
      }),
    );
  } else {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest.projectId !== projectId ||
      manifest.sourceId !== sourceId ||
      manifest.restoredId !== restoredId ||
      JSON.stringify(manifest.inventory) !== JSON.stringify(inventory)
    )
      throw new Error(
        "The frozen synthetic source differs from its pre-backup manifest.",
      );
    const token = await app.options.credential!.getAccessToken();
    async function metadata(resource: string) {
      const response = await fetch(
        `https://firestore.googleapis.com/v1/${resource}`,
        {
          headers: { authorization: `Bearer ${token.access_token}` },
        },
      );
      if (!response.ok) throw new Error("Backup provenance could not be read.");
      return response.json();
    }
    const destination = await metadata(
      `projects/${projectId}/databases/${restoredId}`,
    );
    const provenance = destination.sourceInfo?.backup;
    if (
      destination.sourceInfo?.progress !== "COMPLETED" ||
      !provenance?.backup?.startsWith(
        `projects/${projectId}/locations/us-central1/backups/`,
      ) ||
      !(Date.parse(provenance.snapshotTime) >= Date.parse(manifest.capturedAt))
    )
      throw new Error(
        "The restored database must come from a later completed managed backup.",
      );
    const backup = await metadata(provenance.backup);
    if (
      backup.database !== `projects/${projectId}/databases/${sourceId}` ||
      backup.snapshotTime !== provenance.snapshotTime ||
      backup.state !== "READY"
    )
      throw new Error(
        "The managed backup does not match the isolated synthetic source.",
      );
    const restored = getFirestore(app, restoredId);
    const restoredInspection = await inspectRecoveryIntegrity(restored);
    if (restoredInspection.status !== "integrity_checked")
      throw new Error("The restored copy lacks required evidence.");
    if (
      JSON.stringify(await fingerprint(restored)) !==
      JSON.stringify(manifest.inventory)
    )
      throw new Error("Restored records differ from the pre-backup manifest.");
    console.log(
      JSON.stringify({
        status: "passed",
        snapshotParity: "exact",
        sourceId,
        restoredId,
        collections: Object.keys(inventory).length,
        documents: Object.values(inventory).reduce((n, c) => n + c.count, 0),
        acknowledgements: inventory.acknowledgements!.count,
        backup: provenance.backup,
        snapshotTime: provenance.snapshotTime,
      }),
    );
  }
} catch {
  console.error(
    "Synthetic managed backup parity failed. No record data is logged.",
  );
  process.exitCode = 1;
} finally {
  await deleteApp(app);
}
