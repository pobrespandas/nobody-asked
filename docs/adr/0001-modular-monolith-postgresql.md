---
status: superseded by ADR-0002
---

# Use a TypeScript modular monolith with PostgreSQL

Nobody Asked will start as a TypeScript modular monolith with a JSON HTTP API, a read-only browser application, and PostgreSQL as the hosted system of record. This shape gives the first release one transaction boundary while keeping access, identity, publishing, social graph, feeds, safety, audit and export, API, and browser responsibilities separate.

## Considered options

- A local-first system would add synchronization, conflict, and moderation protocols before the first public conversation.
- A federated system would add remote trust, delivery, and cross-network moderation before the first release.
- Independent services would add deployment and consistency work before measured load requires separate scaling.

## Consequences

The repository uses explicit workspace packages as module boundaries. Domain packages must not depend on HTTP or browser code. PostgreSQL details must remain behind module interfaces so tests can run without sharing production state.
