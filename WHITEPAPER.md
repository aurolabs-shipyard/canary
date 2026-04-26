# Canary — A Bridge from Internal Product Data to CS Alerts

**Version 0.1 · Aurolabs · 2026-04-26**

---

## What it is

Canary is a small, opinionated alerting layer that connects to one read-only source of product-usage data, evaluates a narrow set of account-level health rules, and dispatches Slack alerts to the right CSM. It was built to do **one** job — surface churn-risk signals to non-technical Customer Success teams — without becoming a customer success platform, a health-score builder, or another reverse-ETL tool.

It is shipped as a single-binary CLI (`canary`) with a YAML config, a CSV owner map, and a local SQLite store for snapshots, alert history, and pilot grading.

## Who it's for

The intended buyer is a **Customer Success leader or CS Operations manager at a small B2B SaaS company** who:

- has product-usage data sitting in an internal Postgres replica or warehouse,
- cannot get engineering bandwidth for a custom monitoring/alerting build, and
- needs a few useful Slack alerts on a few obvious churn signals — not a dashboard, not a co-pilot, not a pipeline.

It is **not** for: large CS organisations with a dedicated CS Ops engineer, customers without an internal usage table, or buyers who already have a Looker/Mode + Slack workflow they trust.

## Why it exists (the wedge)

The pain is well-rehearsed: usage data is trapped in a place Zapier cannot reach; getting it out requires engineering; "I'll just ask the dev team" turns into a quarter; meanwhile, churn signals are missed. Existing options force the CS team to either:

1. **Wait on engineering** — slow, low-priority, no maintenance.
2. **Buy a full CS platform** — heavy procurement, long onboarding, scope inflation.
3. **Stitch a reverse-ETL + BI alert** — works, but requires SQL fluency and another vendor in the stack.

Canary's wedge is a sharper third option: a small read-only bridge with a fixed surface area, set up in an afternoon, that delivers the same Slack alerts without any of the platform weight. It is intentionally narrower than incumbents.

## How it works

```
                 ┌──────────────┐
   read-only --> │  connector   │ -- snapshot --> SQLite (account history)
   replica       └──────────────┘                       │
                                                         ▼
                                                   ┌──────────┐
                                                   │  rules   │  account-level
                                                   │  engine  │  thresholds + diffs
                                                   └──────────┘
                                                         │
                                              ┌──────────┴──────────┐
                                              ▼                     ▼
                                      dedupe + fatigue       owner CSV/CRM
                                              │                     │
                                              ▼                     ▼
                                          Slack webhook (cc CSM in channel)
                                              │
                                              ▼
                                      `canary feedback` — pilot grading loop
```

### Components

- **Connector (one surface).** v0.1 ships only Postgres-read-replica. The connector refuses to run if the connected role has any write privileges — Canary is structurally read-only at the database level, not just by convention.
- **Rule engine.** Operator-authored YAML rules use a tiny safe expression DSL — comparisons, arithmetic, logical ops, identifier lookups against a fixed account context. No code execution, no `eval`, no shelling out. Each rule has a `dedupe_window_days` and an optional list of `require:` guards (e.g. "only on accounts with ≥ 5 seats").
- **Owner mapping.** A CSV (`account_id → csm_email, csm_slack_user_id`) — the simplest thing that could possibly work. The interface is deliberately the same shape any CRM export will produce, so the path to a Salesforce/HubSpot adapter is a one-day swap, not a re-architecture.
- **Alert dispatch.** Slack webhook. Two modes: `live` (post to Slack) and `dry-run` (log only). All pilots start in dry-run.
- **Pilot grading loop.** Every alert can be graded `acted | ignored | false_positive` via `canary feedback`. The store tracks per-rule precision and per-CSM ignore streaks. A CSM who ignores N alerts in a row hits the **fatigue gate** — Canary stops paging them until they grade something. This is the answer to the "CSMs ignore noisy alerts" failure mode, in 20 lines of code.
- **Audit + reporting.** Every scan, snapshot, query hash, and alert payload is logged in SQLite. `canary report` produces a pilot accuracy table — exactly the artefact a buyer needs to decide whether to renew.

### Rules shipped in the example config

| Rule              | Severity | Fires when                                                  | Dedupe |
|-------------------|----------|-------------------------------------------------------------|--------|
| `usage-cliff`     | high     | Sessions drop > 50% vs 90-day rolling average               | 7 d    |
| `power-user-loss` | high     | All power users gone (and there were any last snapshot)     | 14 d   |
| `stale-account`   | medium   | No activity in 14+ days (only on accounts with ≥ 5 seats)   | 14 d   |

Three rules is on purpose. The product is "the right three alerts in Slack," not "build your own scoring model."

## How it's deliberately narrow

Canary's MVP scope was set by the structural risks the build prompt flagged. Each "OUT" was chosen for a reason:

| Cut                                    | Why it's out                                                   |
|----------------------------------------|----------------------------------------------------------------|
| Multiple connectors at launch          | One surface that repeats is the only way to avoid services creep |
| Per-customer schema mapping            | Forces a narrow template — if a buyer doesn't fit, they aren't in ICP |
| Health-score builder                   | Where every "lightweight alerting tool" goes to die             |
| Bidirectional CRM sync                 | One-way owner pull is enough for routing; the rest is platform scope |
| On-prem deploy                         | Small-vendor on-prem is a 6-month security review, not a pilot |

## Trust & security posture

The single biggest go/no-go signal during validation is whether a buyer's security team will sign off on a small vendor reading their product-usage data.

- **Read-only at the database level.** Connector aborts on any write privilege detected.
- **No PII required.** The schema is `(account_id, account_name, sessions, power_users, last_active_at, seats)`. No user emails, no event payloads, no message contents.
- **No data leaves the customer's environment.** Snapshots live in a local SQLite file on the operator's host. Slack delivery is the only egress, and the payload is the alert text — no underlying rows.
- **Auditable.** Every scan logs source kind, query hash, row count, and dispatched alerts.
- **Customer-controlled retention.** The SQLite file is theirs; they delete it when they're done. There is no Canary-hosted backend to retain anything.

This posture is the smallest thing that could plausibly clear a security review at a 50-300 person SaaS company. Larger companies are explicitly out of ICP for v0.1.

## What this does NOT solve (yet)

Honest list, since this is a CONDITIONAL-GO build:

- **Schema fit.** The example schema (`cs_account_health`-shaped table) is what every customer needs to either have or build. No ETL, no schema discovery. If they don't have a usage view, Canary doesn't ship.
- **CRM ownership beyond CSV.** A Salesforce/HubSpot adapter is the obvious next module, but is intentionally not in v0.1 until pilots prove the routing model.
- **Webhook ingestion.** Postgres-only at v0.1. A second connector ships only after one customer has run on Postgres for 30 days without custom code.
- **Health score authoring.** There is no UI to compose rules. Rules are YAML, owned by the operator. This is a deliberate ceiling on scope.

## Validation plan (what we're watching during the conditional period)

The build prompt's conditional requirements map directly to evidence we collect during pilots:

| Requirement                                          | How Canary surfaces evidence                                      |
|------------------------------------------------------|-------------------------------------------------------------------|
| 5 design partners w/ data access path                | Each `canary check` run logs source type + query hash             |
| 3 prospects pay for the bridge                       | Tracked outside the product (sales)                               |
| One narrow integration repeats                       | Same query template across 3+ pilots = repeats; log says so       |
| Ownership routing works for 3 companies              | `owners.csv` setup time + unmapped-row warnings from `canary check` |
| Alert quality over 2 weeks for 2 pilots              | `canary report` produces this artefact directly                   |
| Security requirements don't stall adoption           | Read-only enforcement + no-PII schema + local SQLite — measured by time-to-yes |

If any kill trigger fires (no repeating connector, alerts ignored, security blocked, etc.), the right move is to stop and report — not to grow the product to fit.

## Anti-goals

To stay aligned with the conditional-go scope, Canary will explicitly **not**:

- Add a second connector before a Postgres pilot has run for 30 days clean.
- Add a UI before three customers have asked for the same thing.
- Add a hosted version before retention data is in.
- Compete with Pendo, Gainsight, or Vitally on feature breadth.

## Smoketest

```
$ ./node_modules/.bin/tsx src/cli.ts smoketest

=== scan #1 (cold start, no priors) ===
1 alert  · stale-account on Epsilon Ltd

=== scan #2 (after usage drop) ===
2 alerts · usage-cliff on Acme Corp, power-user-loss on Beta Inc
1 dedupe · stale-account on Epsilon Ltd (already alerted within window)

=== pilot report ===
Alerts total:  3
  acted:           2
  ignored:         1
  false positive:  0
Precision: 100% · Action rate: 67%
```

That's the whole product, end to end, in eight seconds.
