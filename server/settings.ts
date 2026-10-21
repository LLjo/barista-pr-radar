import { db } from "./db.js";
import { REFRESH_CHOICES, type RefreshSec, type Settings } from "./types.js";

interface Row { orgs: string; repos: string; refresh_sec: number }

export const DEFAULT_SETTINGS: Settings = { orgs: [], repos: [], refreshSec: 300 };

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Trim, drop empties and duplicates (case-insensitive, first spelling wins). */
export function cleanList(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const v = raw.trim();
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out;
}

export function getSettings(): Settings {
  const row = db.get<Row>("SELECT orgs, repos, refresh_sec FROM pr_radar_settings WHERE id = 1");
  if (!row) return { ...DEFAULT_SETTINGS };
  const refreshSec = (REFRESH_CHOICES as readonly number[]).includes(row.refresh_sec)
    ? (row.refresh_sec as RefreshSec)
    : DEFAULT_SETTINGS.refreshSec;
  return { orgs: parseList(row.orgs), repos: parseList(row.repos), refreshSec };
}

export function saveSettings(input: Settings): Settings {
  const s: Settings = { orgs: cleanList(input.orgs), repos: cleanList(input.repos), refreshSec: input.refreshSec };
  db.run(
    `INSERT INTO pr_radar_settings (id, orgs, repos, refresh_sec, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET orgs = excluded.orgs, repos = excluded.repos,
       refresh_sec = excluded.refresh_sec, updated_at = excluded.updated_at`,
    [JSON.stringify(s.orgs), JSON.stringify(s.repos), s.refreshSec, new Date().toISOString()],
  );
  return s;
}
