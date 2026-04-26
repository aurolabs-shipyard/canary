import { readFileSync } from "node:fs";
import type { Config } from "./config.js";

export type AccountRow = {
  account_id: string;
  account_name: string;
  last_active_at: string | null;
  sessions_last_30d: number;
  power_users_last_30d: number;
  seats: number;
  [key: string]: unknown;
};

export type ConnectorResult = {
  rows: AccountRow[];
  source_kind: string;
  query_hash: string;
  fetched_at: string;
};

const WRITE_PERMISSION_PROBE = `
  SELECT bool_or(privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE'))
    AS has_write
  FROM information_schema.role_table_grants
  WHERE grantee = current_user`;

export async function fetchSnapshot(cfg: Config): Promise<ConnectorResult> {
  if (cfg.source.type === "mock") return fetchMock(cfg);
  if (cfg.source.type === "postgres") return fetchPostgres(cfg);
  throw new Error(`Unsupported source type: ${cfg.source.type}`);
}

function fetchMock(cfg: Config): ConnectorResult {
  const path = cfg.source.mock_path;
  if (!path) throw new Error("source.mock_path required for type=mock");
  const rows = JSON.parse(readFileSync(path, "utf8")) as AccountRow[];
  return {
    rows: rows.map(normalizeRow(cfg)),
    source_kind: "mock",
    query_hash: "mock",
    fetched_at: new Date().toISOString(),
  };
}

async function fetchPostgres(cfg: Config): Promise<ConnectorResult> {
  if (!cfg.source.url || !cfg.source.query) {
    throw new Error("postgres source requires url and query");
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: cfg.source.url });
  await client.connect();
  try {
    const probe = await client.query(WRITE_PERMISSION_PROBE);
    if (probe.rows[0]?.has_write) {
      throw new Error(
        "Refusing to run: connected role has write privileges. " +
          "Canary must use a read-only role on a replica."
      );
    }
    const result = await client.query(cfg.source.query);
    const hash = simpleHash(cfg.source.query);
    return {
      rows: result.rows.map(normalizeRow(cfg)),
      source_kind: "postgres",
      query_hash: hash,
      fetched_at: new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}

function normalizeRow(cfg: Config) {
  const now = Date.now();
  return (raw: Record<string, unknown>): AccountRow => {
    let last_active_at: string | null = (raw.last_active_at as string) ?? null;
    if (last_active_at == null && raw.days_idle != null) {
      const d = Number(raw.days_idle);
      last_active_at = new Date(now - d * 86400_000).toISOString();
    }
    return {
      ...raw,
      account_id: String(raw[cfg.source.account_id_field] ?? raw.account_id),
      account_name: String(raw[cfg.source.account_name_field] ?? raw.account_name ?? ""),
      last_active_at,
      sessions_last_30d: Number(raw.sessions_last_30d ?? 0),
      power_users_last_30d: Number(raw.power_users_last_30d ?? 0),
      seats: Number(raw.seats ?? 0),
    };
  };
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
