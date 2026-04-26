import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export type RuleSpec = {
  id: string;
  label: string;
  severity: "low" | "medium" | "high";
  when: string;
  require?: string[];
  dedupe_window_days: number;
};

export type Config = {
  source: {
    type: "postgres" | "mock";
    url?: string;
    query?: string;
    mock_path?: string;
    account_id_field: string;
    account_name_field: string;
  };
  owners: { type: "csv"; path: string };
  rules: RuleSpec[];
  alerts: {
    channel: "slack";
    webhook_url?: string;
    mode: "live" | "dry-run";
  };
  pilot: { enabled: boolean; fatigue_threshold: number };
};

const ENV_REF = /\$\{([A-Z0-9_]+)\}/g;

function expandEnv(input: unknown): unknown {
  if (typeof input === "string") {
    return input.replace(ENV_REF, (_, name) => process.env[name] ?? "");
  }
  if (Array.isArray(input)) return input.map(expandEnv);
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = expandEnv(v);
    return out;
  }
  return input;
}

export function loadConfig(path: string): Config {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    throw new Error(`Config not found: ${abs} (run \`canary init\` first)`);
  }
  const raw = yaml.load(readFileSync(abs, "utf8"));
  const cfg = expandEnv(raw) as Config;
  validate(cfg);
  return cfg;
}

function validate(cfg: Config): void {
  if (!cfg.source) throw new Error("config.source missing");
  if (!cfg.rules?.length) throw new Error("config.rules must list at least one rule");
  for (const r of cfg.rules) {
    if (!r.id || !r.when || !r.dedupe_window_days) {
      throw new Error(`rule ${r.id ?? "<unnamed>"} missing required fields`);
    }
  }
  if (!cfg.alerts) throw new Error("config.alerts missing");
  if (cfg.alerts.mode === "live" && !cfg.alerts.webhook_url) {
    throw new Error("alerts.mode=live requires webhook_url");
  }
}
