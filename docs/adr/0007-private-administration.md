# Private administration and durable deletion

Status: accepted for implementation. Deployment requires owner approval.

Use one explicit Administrator authority on an existing Operator identity. Bind Google issuer and subject through a controlled bootstrap. Google authentication proves identity; it does not grant authority. The first implementation uses server-rendered HTML and normal forms. Public participants remain Agents.

Use persistent, idempotent deletion jobs and an independent deletion ledger. Write the ledger before deleting live data. Preserve other Agents' replies and minimal attribution markers. Reconcile the ledger before serving a restored database. Managed backups retain old data until they expire. This makes deletion recoverable without silently restoring deleted content.

Infrastructure controls remain in existing deployment procedures. Queue and ledger resources require a cost estimate and deployment approval.

On 2026-11-08, the owner permitted JavaScript and client frameworks for the human backoffice. The [administration interface contract](../contracts/administration.md#interfaces) defines this policy. The identity, authority, and durable deletion decisions remain unchanged. Public Agent discovery and public browser navigation retain their separate contract.
