import type { Config } from "./config.js";
import type { Owner } from "./owners.js";
import type { RuleHit } from "./rules.js";
import type { Store } from "./store.js";
import { dedupeKey } from "./rules.js";

export type DispatchResult = {
  alert_id: number | null;
  delivered: boolean;
  reason: "fired" | "deduped" | "fatigued" | "no_owner_dry_run";
};

export async function dispatch(
  hit: RuleHit,
  owners: Map<string, Owner>,
  store: Store,
  cfg: Config
): Promise<DispatchResult> {
  const key = dedupeKey(hit.account.account_id, hit.rule.id);
  const since = new Date(
    Date.now() - hit.rule.dedupe_window_days * 86400_000
  ).toISOString();
  if (store.recentAlertForKey(key, since)) {
    return { alert_id: null, delivered: false, reason: "deduped" };
  }
  const owner = owners.get(hit.account.account_id) ?? null;
  if (owner && store.consecutiveIgnoredByCsm(owner.csm_email) >= cfg.pilot.fatigue_threshold) {
    return { alert_id: null, delivered: false, reason: "fatigued" };
  }
  const payload = formatSlack(hit, owner);
  const id = store.insertAlert({
    account_id: hit.account.account_id,
    account_name: hit.account.account_name,
    rule_id: hit.rule.id,
    severity: hit.rule.severity,
    fired_at: hit.fired_at,
    dedupe_key: key,
    payload_json: JSON.stringify(payload),
    csm_email: owner?.csm_email ?? null,
  });
  if (cfg.alerts.mode === "live" && cfg.alerts.webhook_url) {
    await postSlack(cfg.alerts.webhook_url, payload);
    return { alert_id: id, delivered: true, reason: "fired" };
  }
  return { alert_id: id, delivered: false, reason: "no_owner_dry_run" };
}

function formatSlack(hit: RuleHit, owner: Owner | null) {
  const sev = { high: ":rotating_light:", medium: ":warning:", low: ":eyes:" }[
    hit.rule.severity
  ];
  const cc = owner?.csm_slack_user_id ? ` cc <@${owner.csm_slack_user_id}>` : "";
  const fields = [
    `*Account:* ${hit.account.account_name} (\`${hit.account.account_id}\`)`,
    `*Rule:* ${hit.rule.label}`,
    `*Sessions (30d):* ${hit.account.sessions_last_30d}` +
      (hit.context.previous_sessions_last_30d != null
        ? ` (was ${hit.context.previous_sessions_last_30d})`
        : ""),
    `*Power users (30d):* ${hit.account.power_users_last_30d}`,
    `*Days idle:* ${
      Number.isFinite(hit.context.days_since_last_active)
        ? hit.context.days_since_last_active
        : "n/a"
    }`,
    `*Seats:* ${hit.account.seats}`,
  ];
  return {
    text: `${sev} Canary churn-risk alert${cc}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `${sev} *Canary churn-risk alert*${cc}` },
      },
      { type: "section", text: { type: "mrkdwn", text: fields.join("\n") } },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Reply with \`canary feedback ${hit.account.account_id} acted|ignored|false_positive\` to grade this alert.`,
          },
        ],
      },
    ],
  };
}

async function postSlack(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook returned ${res.status}: ${await res.text()}`);
  }
}
