#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { fetchSnapshot } from "./connector.js";
import { loadOwners } from "./owners.js";
import { Store } from "./store.js";
import { runScan } from "./scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const cfgPath = () => process.env.CANARY_CONFIG ?? "canary.yaml";
const dbPath = () => process.env.CANARY_DB ?? "canary.db";

function help(): void {
  console.log(`Canary — churn-risk alerts for Customer Success.

Usage:
  canary init                       Scaffold canary.yaml + owners.csv from examples
  canary check                      Validate config, probe data source (read-only)
  canary scan                       Run rules, dispatch alerts, store snapshots
  canary alerts [N]                 List most recent alerts (default 20)
  canary feedback <id> <verdict>    Grade an alert: acted | ignored | false_positive
  canary report                     Pilot accuracy report
  canary smoketest                  Run end-to-end with bundled mock data

Environment:
  CANARY_CONFIG   path to config (default: canary.yaml)
  CANARY_DB       path to sqlite db (default: canary.db)
`);
}

async function cmdInit(): Promise<void> {
  for (const [src, dst] of [
    ["canary.example.yaml", "canary.yaml"],
    ["owners.example.csv", "owners.csv"],
  ] as const) {
    if (existsSync(dst)) {
      console.log(`skip: ${dst} already exists`);
      continue;
    }
    copyFileSync(resolve(PROJECT_ROOT, src), dst);
    console.log(`wrote ${dst}`);
  }
  console.log("\nNext: edit canary.yaml + owners.csv, then run `canary check`.");
}

async function cmdCheck(): Promise<void> {
  const cfg = loadConfig(cfgPath());
  console.log(`config: ${cfgPath()} OK`);
  console.log(`source: ${cfg.source.type}`);
  console.log(`rules:  ${cfg.rules.length}`);
  console.log(`alerts.mode: ${cfg.alerts.mode}`);

  const owners = loadOwners(cfg.owners.path);
  console.log(`owners: ${owners.size} mapped`);

  const snap = await fetchSnapshot(cfg);
  console.log(`source ${snap.source_kind} returned ${snap.rows.length} rows`);
  if (snap.rows.length > 0) {
    const sample = snap.rows[0];
    const unmapped = snap.rows.filter((r) => !owners.has(r.account_id)).length;
    console.log(`sample row keys: ${Object.keys(sample).join(", ")}`);
    if (unmapped > 0) {
      console.log(`warn: ${unmapped} of ${snap.rows.length} rows have no owner mapping`);
    }
  }
}

async function cmdScan(): Promise<void> {
  const cfg = loadConfig(cfgPath());
  const store = new Store(dbPath());
  const s = await runScan(cfg, store);
  console.log(JSON.stringify(s, null, 2));
  if (cfg.alerts.mode === "dry-run") {
    console.log(
      `(dry-run mode: ${s.alerts_fired} alerts stored only — view with \`canary alerts\`)`
    );
  }
}

async function cmdAlerts(limitStr?: string): Promise<void> {
  const limit = limitStr ? Number(limitStr) : 20;
  const store = new Store(dbPath());
  const rows = store.listAlerts(limit);
  if (rows.length === 0) {
    console.log("(no alerts yet — run `canary scan`)");
    return;
  }
  for (const r of rows) {
    const fb = r.feedback === "pending" ? "·" : `[${r.feedback}]`;
    console.log(
      `#${r.id} ${r.fired_at} ${r.severity.padEnd(6)} ${r.rule_id.padEnd(18)} ${r.account_name} (${r.account_id}) ${fb}`
    );
  }
}

async function cmdFeedback(idStr?: string, verdict?: string): Promise<void> {
  if (!idStr || !verdict) throw new Error("usage: canary feedback <alert-id> <acted|ignored|false_positive>");
  if (!["acted", "ignored", "false_positive"].includes(verdict)) {
    throw new Error("verdict must be one of: acted | ignored | false_positive");
  }
  const id = Number(idStr);
  if (!Number.isFinite(id)) throw new Error("alert id must be a number");
  const store = new Store(dbPath());
  if (!store.setFeedback(id, verdict as "acted" | "ignored" | "false_positive")) {
    throw new Error(`no alert with id ${id}`);
  }
  console.log(`alert #${id} → ${verdict}`);
}

async function cmdReport(): Promise<void> {
  const store = new Store(dbPath());
  const s = store.pilotStats();
  if (s.total === 0) {
    console.log("(no alerts to report on yet)");
    return;
  }
  const graded = s.acted + s.ignored + s.false_positive;
  const precision = graded > 0 ? ((s.acted + s.ignored) / graded) * 100 : 0;
  const fpRate = graded > 0 ? (s.false_positive / graded) * 100 : 0;
  const actionRate = graded > 0 ? (s.acted / graded) * 100 : 0;
  console.log("Canary pilot report");
  console.log("===================");
  console.log(`Alerts total:        ${s.total}`);
  console.log(`  acted:             ${s.acted}`);
  console.log(`  ignored:           ${s.ignored}`);
  console.log(`  false positive:    ${s.false_positive}`);
  console.log(`  pending grade:     ${s.pending}`);
  console.log("");
  console.log(`Precision (real):    ${precision.toFixed(1)}%   (acted+ignored / graded)`);
  console.log(`False positive rate: ${fpRate.toFixed(1)}%`);
  console.log(`Action rate:         ${actionRate.toFixed(1)}%   (acted / graded)`);
  console.log("");
  console.log("By rule:");
  for (const r of s.by_rule) {
    const rGraded = r.acted + r.false_positive;
    const rFp = rGraded > 0 ? ((r.false_positive / rGraded) * 100).toFixed(0) : "-";
    console.log(
      `  ${r.rule_id.padEnd(20)} total=${String(r.total).padStart(3)}  acted=${String(r.acted).padStart(3)}  fp=${String(r.false_positive).padStart(3)} (${rFp}%)`
    );
  }
}

async function cmdSmoketest(): Promise<void> {
  process.chdir(PROJECT_ROOT);
  const smokeDir = resolve(PROJECT_ROOT, "smoketest");
  process.env.CANARY_CONFIG = resolve(smokeDir, "canary.smoketest.yaml");
  const tmpDb = resolve(smokeDir, "canary.smoketest.db");
  process.env.CANARY_DB = tmpDb;
  if (existsSync(tmpDb)) {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(tmpDb);
  }
  process.env.CANARY_MOCK_VARIANT = "baseline";
  console.log("=== smoketest: scan #1 (cold start, no priors) ===");
  await cmdScan();
  // Re-run with shifted dataset to exercise dedupe + diff-driven rules.
  process.env.CANARY_MOCK_VARIANT = "drop";
  console.log("\n=== smoketest: scan #2 (after usage drop) ===");
  await cmdScan();
  console.log("\n=== smoketest: alerts ===");
  await cmdAlerts("50");
  console.log("\n=== smoketest: simulating CSM grading ===");
  const store = new Store(tmpDb);
  for (const a of store.listAlerts(50)) {
    const verdict =
      a.rule_id === "usage-cliff" || a.rule_id === "power-user-loss"
        ? "acted"
        : a.account_id === "acc_004"
          ? "false_positive"
          : "ignored";
    store.setFeedback(a.id, verdict as "acted" | "ignored" | "false_positive");
    console.log(`  #${a.id} ${a.rule_id.padEnd(18)} ${a.account_id} → ${verdict}`);
  }
  console.log("\n=== smoketest: report ===");
  await cmdReport();
  console.log("\nsmoketest: OK");
}

async function main(): Promise<void> {
  const [, , cmd, ...args] = process.argv;
  switch (cmd) {
    case "init":
      await cmdInit();
      break;
    case "check":
      await cmdCheck();
      break;
    case "scan":
      await cmdScan();
      break;
    case "alerts":
      await cmdAlerts(args[0]);
      break;
    case "feedback":
      await cmdFeedback(args[0], args[1]);
      break;
    case "report":
      await cmdReport();
      break;
    case "smoketest":
      await cmdSmoketest();
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      help();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
