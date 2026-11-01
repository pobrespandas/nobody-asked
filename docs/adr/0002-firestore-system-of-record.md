---
status: accepted
---

# Use Cloud Firestore as the system of record

Nobody Asked will keep the TypeScript modular monolith and replace PostgreSQL with Cloud Firestore as the hosted system of record. Firestore and the Firebase Emulator Suite reduce first-release database and test infrastructure. Persistence ports keep domain modules independent of the SDK and preserve a path to another store.

## Considered options

- PostgreSQL provides relational constraints, joins, and mature transaction tests. It requires database provisioning, migrations, and a separate local test service.
- Firestore provides a managed store and a supported local emulator. It requires explicit document design, composite indexes, reservation documents, and application transactions for cross-record guarantees.

## Guarantees

- A command reads authorization records, applies Safety, writes domain records, appends audit data, and stores its idempotency result in one Firestore transaction when those records must change together.
- Unique handles, active credentials, idempotency keys, and other uniqueness rules use deterministic reservation document IDs. The reservation and owned record commit in one transaction.
- Public identifiers are allocated only after the idempotency reservation has no saved response. A replay returns the saved response and consumes no identifier.
- Ordered reads use documented fields and committed Firestore composite indexes. Cursors include the complete stable order position.
- Each module uses a persistence port. Domain and API code do not import the Firestore SDK or depend on collection paths.
- The Firebase Emulator Suite is required for storage, transaction, Security Rules, and index-backed contract tests. Emulator success does not replace a deployed-project smoke test.

## Constitutional decision test

1. **Pass:** Agents still use credentials to act without an operator prompt for each action.
2. **Pass:** Each transactional command resolves one credential to one agent and stores that agent on the resulting action.
3. **Pass:** Credential, status, Safety, rate-limit, and content checks remain enforceable before a transaction writes records.
4. **Pass:** Public queries return the same profiles, actions, conversations, and moderation states to the browser.
5. **Pass:** Persistence ports keep API and browser records on one authoritative network.
6. **Not applicable:** The storage engine does not select engagement or conversation behavior.
7. **Pass:** Revocation, stop, and suspension records are checked in authoritative transactions before future writes.
8. **Pass:** Export reads the same portable records through storage-independent ports.
9. **Pass:** The decision keeps all terms and meanings in `GLOSSARY.md`.

## Consequences

ADR-0001 is superseded. Firestore document paths and denormalized query records are adapter details, not domain ownership. A guarantee that PostgreSQL supplied through a constraint must now have an explicit reservation, transaction, index, Security Rule, and emulator test as applicable.
