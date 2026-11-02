# First operator and moderator bootstrap

Use this procedure once, after Access has issued an operator invitation and verified control of its intended identity. The bootstrap consumes that invitation, creates the private Operator record, grants the first Moderator authority, and writes both audit records in one Firestore transaction.

The command is idempotent for the same invitation and Operator. A later run returns the saved result and creates no record. A different invitation or Operator cannot replace the first Moderator.

## Preconditions

- Select the Firebase project and named Firestore database explicitly.
- Use an operator invitation with `recipientProofAt` set by the Access verification flow.
- Store only the invitation secret digest in `operatorInvitations/{invitationId}`.
- Give the deployment identity create and update access only for the private bootstrap collections.
- Review [runtime identity](runtime-identity.md) and [runtime secrets](runtime-secrets.md) before a hosted run.

The invitation document must contain `intendedIdentity`, `secretDigest`, `expiresAt`, `recipientProofAt`, `acceptedAt`, `acceptedOperatorId`, and `revokedAt`. Nullable fields use `null` before acceptance.

## Run

Set non-secret values explicitly:

```sh
export BOOTSTRAP_FIREBASE_PROJECT_ID='reviewed-project-id'
export BOOTSTRAP_FIRESTORE_DATABASE_ID='reviewed-database-id'
export BOOTSTRAP_CONFIRM_TARGET="$BOOTSTRAP_FIREBASE_PROJECT_ID/$BOOTSTRAP_FIRESTORE_DATABASE_ID"
export FIRST_OPERATOR_INVITATION_ID='invitation-first'
export FIRST_OPERATOR_ID='operator-first'
export BOOTSTRAP_CORRELATION_ID='bootstrap-first-operator'
```

Read the invitation secret without adding it to shell history:

```sh
read -r -s FIRST_OPERATOR_INVITATION_SECRET
export FIRST_OPERATOR_INVITATION_SECRET
npx tsx tools/bootstrap-first-operator.ts
unset FIRST_OPERATOR_INVITATION_SECRET
```

The JSON result contains the invitation ID, Operator ID, completion time, and whether the command changed state. It never contains the invitation secret or digest.

## Verify

Confirm all of these records before the deployment proceeds:

1. The invitation has one acceptance time and the expected Operator ID.
2. `operators/{operatorId}` contains the private identity and source invitation.
3. `moderatorAuthorities/{operatorId}` has source `first_operator_bootstrap`.
4. `bootstrapControls/firstOperatorModerator` identifies the same invitation and Operator.
5. The audit log contains `operator.enrolled` and `moderator.authority_granted` with the deployment bootstrap actor.
6. A repeated command returns `changed: false` and does not change record counts.

Stop if any record is absent or names another Operator. Keep the deployment blocked and investigate the Firestore transaction. Do not create or edit authority records by hand.
