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

The command fails closed while a required budget or usage decision is `null`. It does not create cloud resources. The verified budget fields now pass. The granular usage fields remain incomplete.

## Real platform limits

- Firestore read and write usage is observable. Its service quotas are provider limits, not a per-application spending cap. Use Monitoring alerts and the application rate limits.
- Cloud Run supports a maximum instance setting after the service exists. Select the value before deployment. Monitor request count and billable instance time.
- Firebase Hosting has no repository-controlled hard spend limit for one site. Monitor served bytes and project cost.
- Cloud Logging retains the `_Default` bucket for 30 days. Monitor ingested bytes. Keep the current retention unless a reviewed retention change is required.
- Outbound traffic has no safe automatic project shutdown boundary. Monitor network egress bytes and cost.
- A Cloud Billing budget sends alerts. It does not cap spend. Automatic shutdown remains disabled.

## Required decisions

The budget amount, thresholds, and recipient are approved and configured. Choose the remaining usage values together:

1. Hourly Firestore read and write thresholds.
2. Hourly Cloud Run request threshold and maximum instances.
3. Hourly Hosting, log ingestion, and egress byte thresholds.

The approved budget thresholds are 50%, 80%, and 100%.

## Response

At 50% or the first usage warning, inspect the service and metric by environment. At 80%, stop non-essential jobs, investigate unexpected clients, and prepare traffic reduction. At 100%, require an operator decision before any capacity increase. Preserve credential revocation, operator stop, audit, backup, and public-read safety paths. Do not automate destructive shutdown.

## Remote completion

Budget creation is complete. After the remaining usage decisions exist, create metric alerts for each usage field, apply the selected Cloud Run maximum instance value, and test every notification in non-production. Record resource names and test times, not message contents.
