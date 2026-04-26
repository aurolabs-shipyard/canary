import Database from "better-sqlite3";
import type { AccountRow } from "./connector.js";

export type AlertRecord = {
  id: number;
  account_id: string;
  account_name: string;
  rule_id: string;
  severity: string;
  fired_at: string;
  dedupe_key: string;
  payload_json: string;
  csm_email: string | null;
  feedback: "pending" | "acted" | "ignored" | "false_positive";
  feedback_at: string | null;
};

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        account_id TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        sessions_last_30d INTEGER NOT NULL,
        power_users_last_30d INTEGER NOT NULL,
        last_active_at TEXT,
        seats INTEGER NOT NULL,
        PRIMARY KEY (account_id, captured_at)
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        account_name TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        fired_at TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        csm_email TEXT,
        feedback TEXT NOT NULL DEFAULT 'pending',
        feedback_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(dedupe_key, fired_at);
      CREATE INDEX IF NOT EXISTS idx_alerts_csm ON alerts(csm_email, fired_at);
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        source_kind TEXT NOT NULL,
        query_hash TEXT NOT NULL,
        rows_seen INTEGER NOT NULL DEFAULT 0,
        alerts_fired INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  startScan(source_kind: string, query_hash: string): number {
    const r = this.db
      .prepare("INSERT INTO scans (started_at, source_kind, query_hash) VALUES (?, ?, ?)")
      .run(new Date().toISOString(), source_kind, query_hash);
    return Number(r.lastInsertRowid);
  }

  finishScan(id: number, rows_seen: number, alerts_fired: number): void {
    this.db
      .prepare(
        "UPDATE scans SET finished_at = ?, rows_seen = ?, alerts_fired = ? WHERE id = ?"
      )
      .run(new Date().toISOString(), rows_seen, alerts_fired, id);
  }

  saveSnapshot(row: AccountRow, captured_at: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO snapshots
         (account_id, captured_at, sessions_last_30d, power_users_last_30d, last_active_at, seats)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.account_id,
        captured_at,
        row.sessions_last_30d,
        row.power_users_last_30d,
        row.last_active_at,
        row.seats
      );
  }

  previousSnapshot(account_id: string, before: string) {
    return this.db
      .prepare(
        `SELECT * FROM snapshots
         WHERE account_id = ? AND captured_at < ?
         ORDER BY captured_at DESC LIMIT 1`
      )
      .get(account_id, before) as
      | {
          sessions_last_30d: number;
          power_users_last_30d: number;
          last_active_at: string | null;
          captured_at: string;
        }
      | undefined;
  }

  recentSnapshots(account_id: string, since: string) {
    return this.db
      .prepare(
        `SELECT sessions_last_30d FROM snapshots
         WHERE account_id = ? AND captured_at >= ?
         ORDER BY captured_at DESC`
      )
      .all(account_id, since) as { sessions_last_30d: number }[];
  }

  recentAlertForKey(dedupe_key: string, since: string): AlertRecord | undefined {
    return this.db
      .prepare(
        `SELECT * FROM alerts WHERE dedupe_key = ? AND fired_at >= ?
         ORDER BY fired_at DESC LIMIT 1`
      )
      .get(dedupe_key, since) as AlertRecord | undefined;
  }

  insertAlert(a: Omit<AlertRecord, "id" | "feedback" | "feedback_at">): number {
    const r = this.db
      .prepare(
        `INSERT INTO alerts
         (account_id, account_name, rule_id, severity, fired_at, dedupe_key, payload_json, csm_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        a.account_id,
        a.account_name,
        a.rule_id,
        a.severity,
        a.fired_at,
        a.dedupe_key,
        a.payload_json,
        a.csm_email
      );
    return Number(r.lastInsertRowid);
  }

  setFeedback(id: number, verdict: AlertRecord["feedback"]): boolean {
    const r = this.db
      .prepare("UPDATE alerts SET feedback = ?, feedback_at = ? WHERE id = ?")
      .run(verdict, new Date().toISOString(), id);
    return r.changes > 0;
  }

  consecutiveIgnoredByCsm(csm_email: string): number {
    const rows = this.db
      .prepare(
        `SELECT feedback FROM alerts WHERE csm_email = ?
         ORDER BY fired_at DESC LIMIT 50`
      )
      .all(csm_email) as { feedback: string }[];
    let count = 0;
    for (const r of rows) {
      if (r.feedback === "ignored") count++;
      else if (r.feedback === "pending") continue;
      else break;
    }
    return count;
  }

  pilotStats(): {
    total: number;
    acted: number;
    ignored: number;
    false_positive: number;
    pending: number;
    by_rule: { rule_id: string; total: number; acted: number; false_positive: number }[];
  } {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(feedback='acted') AS acted,
           SUM(feedback='ignored') AS ignored,
           SUM(feedback='false_positive') AS false_positive,
           SUM(feedback='pending') AS pending
         FROM alerts`
      )
      .get() as Record<string, number | null>;
    const byRule = this.db
      .prepare(
        `SELECT rule_id,
                COUNT(*) AS total,
                SUM(feedback='acted') AS acted,
                SUM(feedback='false_positive') AS false_positive
         FROM alerts GROUP BY rule_id ORDER BY total DESC`
      )
      .all() as { rule_id: string; total: number; acted: number; false_positive: number }[];
    return {
      total: Number(totals.total ?? 0),
      acted: Number(totals.acted ?? 0),
      ignored: Number(totals.ignored ?? 0),
      false_positive: Number(totals.false_positive ?? 0),
      pending: Number(totals.pending ?? 0),
      by_rule: byRule,
    };
  }

  listAlerts(limit = 20): AlertRecord[] {
    return this.db
      .prepare(`SELECT * FROM alerts ORDER BY fired_at DESC LIMIT ?`)
      .all(limit) as AlertRecord[];
  }
}
