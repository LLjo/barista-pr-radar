import { openStorage, type Storage } from "@barista/plugin-sdk/sqlite";
import { join } from "path";

const DATA_DIR = process.env.PLUGIN_DATA_DIR
  ? join(process.env.PLUGIN_DATA_DIR, "pr-radar")
  : join(import.meta.dirname, "..", "data");

export const db: Storage = await openStorage({ dir: DATA_DIR, name: "pr-radar" });

db.exec(`
  CREATE TABLE IF NOT EXISTS pr_radar_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    orgs TEXT NOT NULL DEFAULT '[]',
    repos TEXT NOT NULL DEFAULT '[]',
    refresh_sec INTEGER NOT NULL DEFAULT 300,
    updated_at TEXT NOT NULL
  );
`);

/** Checkpoint the WAL and close — registered with `registerShutdown` in index.ts. */
export function closeDb(): void {
  db.close();
}
