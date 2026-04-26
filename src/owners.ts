import { readFileSync, existsSync } from "node:fs";

export type Owner = {
  account_id: string;
  csm_email: string;
  csm_slack_user_id: string | null;
};

export function loadOwners(path: string): Map<string, Owner> {
  const map = new Map<string, Owner>();
  if (!existsSync(path)) return map;
  const text = readFileSync(path, "utf8").trim();
  if (!text) return map;
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",").map((s) => s.trim());
  const idx = (name: string) => header.indexOf(name);
  const aIdx = idx("account_id");
  const eIdx = idx("csm_email");
  const sIdx = idx("csm_slack_user_id");
  if (aIdx === -1 || eIdx === -1) {
    throw new Error("owners.csv missing required columns: account_id, csm_email");
  }
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map((s) => s.trim());
    if (!cells[aIdx]) continue;
    map.set(cells[aIdx], {
      account_id: cells[aIdx],
      csm_email: cells[eIdx] ?? "",
      csm_slack_user_id: sIdx !== -1 ? cells[sIdx] || null : null,
    });
  }
  return map;
}
