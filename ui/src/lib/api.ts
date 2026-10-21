import { unwrap } from "@barista/plugin-sdk/ui/http";
import type { Settings, Snapshot } from "./types.js";

// Plain fetch with named types: hc<AppType> would drag the server modules (sqlite, gh) into the
// browser typecheck. Every call goes through unwrap(): res.json() does not throw on a 4xx/5xx.
const BASE = "/api/pr-radar";
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const getSnapshot = () => unwrap<Snapshot>(fetch(`${BASE}/prs`));
export const refresh = () => unwrap<Snapshot>(fetch(`${BASE}/refresh`, { method: "POST" }));
export const getSettings = () => unwrap<Settings>(fetch(`${BASE}/settings`));
export const saveSettings = (s: Settings) => unwrap<Settings>(fetch(`${BASE}/settings`, json("PUT", s)));
