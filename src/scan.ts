import type { Config } from "./config.js";
import { fetchSnapshot } from "./connector.js";
import { loadOwners } from "./owners.js";
import { Store } from "./store.js";
import { buildContext, evaluate } from "./rules.js";
import { dispatch } from "./alerts.js";

export type ScanSummary = {
  scan_id: number;
  rows_seen: number;
  rules_evaluated: number;
  alerts_fired: number;
  alerts_deduped: number;
  alerts_fatigued: number;
  delivered: number;
};

export async function runScan(cfg: Config, store: Store): Promise<ScanSummary> {
  const owners = loadOwners(cfg.owners.path);
  const snapshot = await fetchSnapshot(cfg);
  const scan_id = store.startScan(snapshot.source_kind, snapshot.query_hash);
  const asOf = new Date(snapshot.fetched_at);

  let fired = 0;
  let deduped = 0;
  let fatigued = 0;
  let delivered = 0;
  let evaluations = 0;

  for (const row of snapshot.rows) {
    const ctx = buildContext(row, store, asOf);
    for (const rule of cfg.rules) {
      evaluations++;
      if (!evaluate(rule, ctx)) continue;
      const result = await dispatch(
        { rule, account: row, context: ctx, fired_at: snapshot.fetched_at },
        owners,
        store,
        cfg
      );
      if (result.reason === "deduped") deduped++;
      else if (result.reason === "fatigued") fatigued++;
      else fired++;
      if (result.delivered) delivered++;
    }
    store.saveSnapshot(row, snapshot.fetched_at);
  }

  store.finishScan(scan_id, snapshot.rows.length, fired);
  return {
    scan_id,
    rows_seen: snapshot.rows.length,
    rules_evaluated: evaluations,
    alerts_fired: fired,
    alerts_deduped: deduped,
    alerts_fatigued: fatigued,
    delivered,
  };
}
