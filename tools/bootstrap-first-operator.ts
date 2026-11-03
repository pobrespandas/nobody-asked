import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import {
  Timestamp,
  getFirestore,
  type DocumentData,
  type Firestore,
  type Transaction,
} from "firebase-admin/firestore";
import {
  bootstrapFirstOperator,
  bootstrapEnrolledOperator,
  type BootstrapAuditRecord,
  type FirstOperatorBootstrapRecord,
  type FirstOperatorBootstrapState,
  type FirstOperatorBootstrapStore,
  type FirstOperatorBootstrapTransaction,
  type ModeratorAuthorityRecord,
  type OperatorInvitationRecord,
  type OperatorRecord,
  type OperatorSessionRecord,
} from "@nobody-asked/access";

export async function runFirstOperatorBootstrap(
  environment: NodeJS.ProcessEnv = process.env,
  authentication?: {
    readonly mode: "enrolled-session";
    readonly sessionToken: string;
    readonly origin: string;
  },
  deploymentFirestore?: Firestore,
) {
  if (authentication && authentication.mode !== "enrolled-session")
    throw new Error("Unknown bootstrap authentication mode.");
  const projectId = required(environment, "BOOTSTRAP_FIREBASE_PROJECT_ID");
  const databaseId = required(environment, "BOOTSTRAP_FIRESTORE_DATABASE_ID");
  const expectedTarget = `${projectId}/${databaseId}`;
  if (
    authentication &&
    expectedTarget !== "gen-lang-client-0607406471/nobody-asked-dev"
  )
    throw new Error(
      "Enrolled bootstrap requires the reviewed project and database.",
    );
  if (required(environment, "BOOTSTRAP_CONFIRM_TARGET") !== expectedTarget) {
    throw new Error("BOOTSTRAP_CONFIRM_TARGET must equal project/database.");
  }

  if (
    deploymentFirestore &&
    ((deploymentFirestore as Firestore & { readonly projectId?: string })
      .projectId !== projectId ||
      deploymentFirestore.databaseId !== databaseId)
  )
    throw new Error("The deployment client must match the reviewed target.");
  const app = deploymentFirestore
    ? undefined
    : initializeApp({ projectId, credential: applicationDefault() });
  try {
    const firestore = deploymentFirestore ?? getFirestore(app!, databaseId);
    if (authentication)
      return await bootstrapEnrolledOperator(
        {
          store: createFirestoreBootstrapStore(firestore),
          digestSecret: digest,
          digestsMatch,
          now: () => new Date(),
        },
        {
          invitationId: required(environment, "FIRST_OPERATOR_INVITATION_ID"),
          operatorId: required(environment, "FIRST_OPERATOR_ID"),
          correlationId: required(environment, "BOOTSTRAP_CORRELATION_ID"),
          sessionToken: authentication.sessionToken,
          origin: authentication.origin,
        },
      );
    return await bootstrapFirstOperator(
      {
        store: createFirestoreBootstrapStore(firestore),
        digestSecret: digest,
        digestsMatch,
        now: () => new Date(),
      },
      {
        invitationId: required(environment, "FIRST_OPERATOR_INVITATION_ID"),
        invitationSecret: required(
          environment,
          "FIRST_OPERATOR_INVITATION_SECRET",
        ),
        operatorId: required(environment, "FIRST_OPERATOR_ID"),
        correlationId: required(environment, "BOOTSTRAP_CORRELATION_ID"),
      },
    );
  } finally {
    if (app) await deleteApp(app);
  }
}

export function createFirestoreBootstrapStore(
  firestore: Firestore,
): FirstOperatorBootstrapStore {
  return Object.freeze({
    transact: <Result>(
      work: (transaction: FirstOperatorBootstrapTransaction) => Promise<Result>,
    ) =>
      firestore.runTransaction((native) =>
        work(new FirestoreBootstrapTransaction(firestore, native)),
      ),
  });
}

class FirestoreBootstrapTransaction implements FirstOperatorBootstrapTransaction {
  constructor(
    private readonly firestore: Firestore,
    private readonly transaction: Transaction,
  ) {}

  async readSession(sessionId: string): Promise<OperatorSessionRecord | null> {
    const snapshot = await this.transaction.get(
      this.firestore.collection("operatorSessions").doc(sessionId),
    );
    const data = snapshot.data();
    return data
      ? {
          id: sessionId,
          operatorId: String(data.operatorId),
          secretDigest: String(data.secretDigest),
          origin: String(data.origin),
          authenticatedAt: asDate(data.authenticatedAt),
          expiresAt: asDate(data.expiresAt),
          revokedAt: nullableDate(data.revokedAt),
        }
      : null;
  }

  async readState(
    invitationId: string,
    operatorId: string,
  ): Promise<FirstOperatorBootstrapState> {
    const invitationRef = this.firestore
      .collection("operatorInvitations")
      .doc(invitationId);
    const bootstrapRef = this.firestore
      .collection("bootstrapControls")
      .doc("firstOperatorModerator");
    const operatorRef = this.firestore.collection("operators").doc(operatorId);
    const authorityRef = this.firestore
      .collection("moderatorAuthorities")
      .doc(operatorId);
    const authorityQuery = this.firestore
      .collection("moderatorAuthorities")
      .limit(1);
    const [invitation, bootstrap, operator, authority, authorities] =
      await Promise.all([
        this.transaction.get(invitationRef),
        this.transaction.get(bootstrapRef),
        this.transaction.get(operatorRef),
        this.transaction.get(authorityRef),
        this.transaction.get(authorityQuery),
      ]);
    return Object.freeze({
      invitation: invitation.exists
        ? mapInvitation(invitation.id, invitation.data()!)
        : null,
      bootstrap: bootstrap.exists ? mapBootstrap(bootstrap.data()!) : null,
      operator: operator.exists
        ? mapOperator(operator.id, operator.data()!)
        : null,
      moderatorAuthority: authority.exists
        ? mapAuthority(authority.id, authority.data()!)
        : null,
      anyModeratorAuthority: authorities.empty
        ? null
        : mapAuthority(authorities.docs[0]!.id, authorities.docs[0]!.data()),
    });
  }

  acceptInvitation(record: OperatorInvitationRecord): void {
    this.transaction.update(
      this.firestore.collection("operatorInvitations").doc(record.id),
      {
        acceptedAt: Timestamp.fromDate(record.acceptedAt!),
        acceptedOperatorId: record.acceptedOperatorId,
      },
    );
  }

  createOperator(record: OperatorRecord): void {
    this.transaction.create(
      this.firestore.collection("operators").doc(record.id),
      {
        normalizedIdentity: record.normalizedIdentity,
        sourceInvitationId: record.sourceInvitationId,
        createdAt: Timestamp.fromDate(record.createdAt),
      },
    );
  }

  createModeratorAuthority(record: ModeratorAuthorityRecord): void {
    this.transaction.create(
      this.firestore.collection("moderatorAuthorities").doc(record.operatorId),
      {
        grantedAt: Timestamp.fromDate(record.grantedAt),
        source: record.source,
      },
    );
  }

  createBootstrapRecord(record: FirstOperatorBootstrapRecord): void {
    this.transaction.create(
      this.firestore
        .collection("bootstrapControls")
        .doc("firstOperatorModerator"),
      {
        invitationId: record.invitationId,
        operatorId: record.operatorId,
        completedAt: Timestamp.fromDate(record.completedAt),
      },
    );
  }

  createAuditRecord(record: BootstrapAuditRecord): void {
    this.transaction.create(
      this.firestore.collection("auditRecords").doc(record.id),
      {
        actorType: record.actorType,
        actorId: record.actorId,
        action: record.action,
        subjectType: record.subjectType,
        subjectId: record.subjectId,
        result: record.result,
        reasonCategory: null,
        previousState: null,
        resultingState: null,
        correlationId: record.correlationId,
        requestOrigin: null,
        credentialId: null,
        retentionRange: null,
        createdAt: Timestamp.fromDate(record.createdAt),
        expireAt: Timestamp.fromDate(record.expireAt),
      },
    );
  }
}

function mapInvitation(
  id: string,
  data: DocumentData,
): OperatorInvitationRecord {
  return Object.freeze({
    id,
    intendedIdentity: String(data.intendedIdentity),
    secretDigest: String(data.secretDigest),
    expiresAt: asDate(data.expiresAt),
    recipientProofAt: nullableDate(data.recipientProofAt),
    acceptedAt: nullableDate(data.acceptedAt),
    acceptedOperatorId:
      typeof data.acceptedOperatorId === "string"
        ? data.acceptedOperatorId
        : null,
    revokedAt: nullableDate(data.revokedAt),
  });
}

function mapBootstrap(data: DocumentData): FirstOperatorBootstrapRecord {
  return Object.freeze({
    invitationId: String(data.invitationId),
    operatorId: String(data.operatorId),
    completedAt: asDate(data.completedAt),
  });
}

function mapOperator(id: string, data: DocumentData): OperatorRecord {
  return Object.freeze({
    id,
    normalizedIdentity: String(data.normalizedIdentity),
    sourceInvitationId: String(data.sourceInvitationId),
    createdAt: asDate(data.createdAt),
    active: data.active !== false,
    revokedAt: nullableDate(data.revokedAt),
    disabledAt: nullableDate(data.disabledAt),
  });
}

function mapAuthority(
  operatorId: string,
  data: DocumentData,
): ModeratorAuthorityRecord {
  return Object.freeze({
    operatorId,
    grantedAt: asDate(data.grantedAt),
    source: "first_operator_bootstrap",
  });
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestsMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function asDate(value: unknown): Date {
  if (!(value instanceof Timestamp)) throw new Error("Expected a timestamp.");
  return value.toDate();
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runFirstOperatorBootstrap();
  process.stdout.write(
    `${JSON.stringify({ ...result, completedAt: result.completedAt.toISOString() })}\n`,
  );
}
