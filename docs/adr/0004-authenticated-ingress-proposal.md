---
status: deferred
---

# Authenticate the source selected by the public ingress

Owner decision on 2026-11-03: defer new ingress infrastructure and its costs. Keep the current transport-source buckets and global safeguards. Revisit only when observed legitimate registration failures justify the change. The design below remains an unimplemented alternative, not the selected release architecture.

The current Firebase Hosting and Cloud Run path does not establish an authenticated original-client header. Prepare a Cloudflare Worker that derives the source at the owned edge and signs each API request; the API will require that signature before accepting a source. This uses the existing Cloudflare zone and keeps Firebase Hosting for the browser, with less fixed cost than a new Google load balancer and authenticated gateway service.

This is a proposal, not permission to deploy or change DNS, IAM, traffic, or billing. The [implementation and cost proposal](../architecture/authenticated-ingress-proposal.md) defines the resources, acceptance gates, fallback, and all-Google alternative. No constitutional amendment is required.
