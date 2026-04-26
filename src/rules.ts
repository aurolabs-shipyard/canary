import type { RuleSpec } from "./config.js";
import type { AccountRow } from "./connector.js";
import type { Store } from "./store.js";
import { compileExpr } from "./expr.js";

export type EvalContext = AccountRow & {
  days_since_last_active: number;
  previous_sessions_last_30d: number | null;
  previous_power_users: number | null;
  rolling_avg_sessions_90d: number | null;
};

export type RuleHit = {
  rule: RuleSpec;
  account: AccountRow;
  context: EvalContext;
  fired_at: string;
};

export function buildContext(row: AccountRow, store: Store, asOf: Date): EvalContext {
  const prev = store.previousSnapshot(row.account_id, asOf.toISOString());
  const ninetyDaysAgo = new Date(asOf.getTime() - 90 * 86400_000).toISOString();
  const recent = store.recentSnapshots(row.account_id, ninetyDaysAgo);
  const avg =
    recent.length > 0
      ? recent.reduce((s, r) => s + r.sessions_last_30d, 0) / recent.length
      : null;
  const days =
    row.last_active_at != null
      ? Math.floor((asOf.getTime() - new Date(row.last_active_at).getTime()) / 86400_000)
      : Number.POSITIVE_INFINITY;
  return {
    ...row,
    days_since_last_active: days,
    previous_sessions_last_30d: prev?.sessions_last_30d ?? null,
    previous_power_users: prev?.power_users_last_30d ?? null,
    rolling_avg_sessions_90d: avg,
  };
}

export function evaluate(rule: RuleSpec, ctx: EvalContext): boolean {
  for (const guard of rule.require ?? []) {
    if (!truthy(safeRun(guard, ctx))) return false;
  }
  return truthy(safeRun(rule.when, ctx));
}

function safeRun(expr: string, ctx: EvalContext): unknown {
  try {
    return compileExpr(expr)(ctx as unknown as Record<string, unknown>);
  } catch {
    return false;
  }
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  return Boolean(v);
}

export function dedupeKey(account_id: string, rule_id: string): string {
  return `${account_id}::${rule_id}`;
}
