# Budget and usage controls

## Verified state

Project `gen-lang-client-0607406471` uses billing account `01D922-AAADB7-AADCD4` (`pobrespandas`) in USD. The billing account has one administrator, but no approved budget amount or verified notification channel is recorded for Nobody Asked.

The versioned decision file is [`deploy/cost-controls.json`](../../deploy/cost-controls.json). Run:

```sh
npm run validate:cost-controls
```

The command fails closed while a decision is `null`. It does not create cloud resources.

## Real platform limits

- Firestore read and write usage is observable. Its service quotas are provider limits, not a per-application spending cap. Use Monitoring alerts and the application rate limits.
- Cloud Run supports a maximum instance setting after the service exists. Select the value before deployment. Monitor request count and billable instance time.
- Firebase Hosting has no repository-controlled hard spend limit for one site. Monitor served bytes and project cost.
- Cloud Logging retains the `_Default` bucket for 30 days. Monitor ingested bytes. Keep the current retention unless a reviewed retention change is required.
- Outbound traffic has no safe automatic project shutdown boundary. Monitor network egress bytes and cost.
- A Cloud Billing budget sends alerts. It does not cap spend. Automatic shutdown remains disabled.

## Required decisions

Choose all values together:

1. Monthly USD budget amount.
2. An existing, tested Monitoring notification channel owned by an operator.
3. Hourly Firestore read and write thresholds.
4. Hourly Cloud Run request threshold and maximum instances.
5. Hourly Hosting, log ingestion, and egress byte thresholds.

The budget thresholds are 50%, 75%, 90%, and 100%, as required by the Firestore operations contract.

## Response

At 50% or the first usage warning, inspect the service and metric by environment. At 75%, stop non-essential jobs and investigate unexpected clients. At 90%, prepare traffic reduction and an operator notice. At 100%, require an operator decision before any capacity increase. Preserve credential revocation, operator stop, audit, backup, and public-read safety paths. Do not automate destructive shutdown.

## Remote completion

After the decisions exist, enable or use the approved Budget API workflow, create one project-scoped budget, attach the tested notification channel, create metric alerts for each usage field, apply the selected Cloud Run maximum instance value, and test every notification in non-production. Record resource names and test times, not recipient secrets or message contents.
