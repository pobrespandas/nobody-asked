# Budget and usage controls

## Verified state

Project `gen-lang-client-0607406471` uses billing account `01D922-AAADB7-AADCD4` (`pobrespandas`) in USD. Budget `nobody-asked-monthly-usd-20` is active at `billingAccounts/01D922-AAADB7-AADCD4/budgets/02f72ab9-f0cc-40eb-a10e-aaa2e434b2f5`.

The budget has these verified controls:

- Monthly amount: USD 20.
- Project filter: `projects/284051889944`, the numeric resource for `gen-lang-client-0607406471`.
- Current-spend alerts: 50%, 80%, and 100%.
- Notification channel: `projects/gen-lang-client-0607406471/notificationChannels/1508763003618954322`.
- Recipient: `andres.tobelem@gmail.com` through an enabled email channel.
- Default billing-account recipients: disabled.
- Pub/Sub notification and automatic shutdown: absent.

The Budget API is enabled on the explicit project. Existing budgets on the billing account were not changed.

The versioned decision file is [`deploy/cost-controls.json`](../../deploy/cost-controls.json). Run:

```sh
npm run validate:cost-controls
```

The command fails closed when a value, target, metric, or remote resource name differs from the approved configuration. It does not create cloud resources. The budget and usage controls pass.

## Usage alerts

All usage policies are enabled. They use the approved notification channel. Each policy aligns delta values over 3,600 seconds with `ALIGN_SUM`, then uses `REDUCE_SUM` across the selected resource series. The threshold triggers when the hourly sum is greater than the approved value.

| Control            | Target                                       | Metric                                                    |  Hourly threshold | Alert policy           |
| ------------------ | -------------------------------------------- | --------------------------------------------------------- | ----------------: | ---------------------- |
| Firestore reads    | Database `nobody-asked-dev` in `us-central1` | `firestore.googleapis.com/document/read_ops_count`        |  5,000 operations | `4916302908982707238`  |
| Firestore writes   | Database `nobody-asked-dev` in `us-central1` | `firestore.googleapis.com/document/write_ops_count`       |  1,000 operations | `4766119967295252686`  |
| Cloud Run requests | Service `nobody-asked-api` in `us-central1`  | `run.googleapis.com/request_count`                        |   10,000 requests | `1440781591262637132`  |
| Hosting traffic    | Site `nobodyasked-pobrespandas-prod`         | `firebasehosting.googleapis.com/network/sent_bytes_count` | 500,000,000 bytes | `8976115789455895084`  |
| Log ingestion      | Project `gen-lang-client-0607406471`         | `logging.googleapis.com/billing/bytes_ingested`           | 100,000,000 bytes | `10442644089654689159` |
| Cloud Run egress   | Service `nobody-asked-api` in `us-central1`  | `run.googleapis.com/container/network/sent_bytes_count`   | 500,000,000 bytes | `5110408576204733930`  |

The byte thresholds use decimal MB: 500 MB is 500,000,000 bytes, and 100 MB is 100,000,000 bytes.

The egress alert is service-scoped. Cloud Monitoring does not expose one project-wide egress-byte metric that applies to Cloud Run, Hosting, and all other services. The available `networking.googleapis.com/vm_flow/egress_bytes_count` metric applies to Compute Engine VM instances, so it cannot measure this Cloud Run service. The selected `run.googleapis.com/container/network/sent_bytes_count` metric is the verifiable alternative for `nobody-asked-api`. Review billing data separately for project-wide egress cost.

Cloud Run revision `nobody-asked-api-00003-pp5` applies `autoscaling.knative.dev/maxScale=2` and serves 100% of traffic. This is a capacity limit. It is not an hourly request cap.

## Real platform limits

- Firestore read and write usage is observable. Its service quotas are provider limits, not a per-application spending cap. Use Monitoring alerts and the application rate limits.
- Cloud Run has a maximum of two instances. Monitor request count and billable instance time.
- Firebase Hosting has no repository-controlled hard spend limit for one site. Monitor served bytes and project cost.
- Cloud Logging retains the `_Default` bucket for 30 days. Monitor ingested bytes. Keep the current retention unless a reviewed retention change is required.
- Outbound traffic has no safe automatic project shutdown boundary. Monitor network egress bytes and cost.
- A Cloud Billing budget sends alerts. It does not cap spend. Automatic shutdown remains disabled.

## Response

At 50% or the first usage warning, inspect the service and metric by environment. At 80%, stop non-essential jobs, investigate unexpected clients, and prepare traffic reduction. At 100%, require an operator decision before any capacity increase. Preserve credential revocation, operator stop, audit, backup, and public-read safety paths. Do not automate destructive shutdown.

## Remote verification

Verify the policy resource names, enabled state, channel, metric filters, hourly alignment, reducers, and thresholds before each release. Verify that the latest Cloud Run revision has a maximum scale of two and receives all traffic. A policy test can create a real notification. Run it only in a reviewed non-production test and record the time, not the message contents.
