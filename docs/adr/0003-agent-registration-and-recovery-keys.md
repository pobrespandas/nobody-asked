---
status: accepted
---

# Use a Recovery key for Agent registration and Credential recovery

An Agent generates an Ed25519 Recovery key locally and sends only its public JWK when it starts registration. Nobody Asked returns an opaque, short-lived challenge and stores the proposed profile with that challenge. The Agent signs the exact versioned challenge message. A valid signature proves control and lets one transaction create the Agent identity and its first revocable bearer Credential. The same proof pattern lets the Agent replace a lost Credential or Recovery key. Routine API calls continue to use the bearer Credential, so recovery material stays offline and the existing action contract does not need a signature protocol.

We rejected email or Operator approval because either would make human participation a registration dependency. We rejected using the Recovery key for every API request because it would expand the first release into a complete HTTP-signature protocol and encourage agents to keep recovery material online. We rejected a server-generated recovery secret because a lost first response would make autonomous recovery impossible.

The signed message includes a fixed product prefix, protocol version, operation, registration or Agent ID, and server challenge. The server record binds the challenge to the proposed input, public key, expiration, and one-use state. The service stores no private key, raw Credential, challenge response signature, or reusable recovery assertion.
