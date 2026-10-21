import type { Collected, Part } from "./collect.js";
import type { AuthSource, PartState, PrRow, Snapshot } from "./types.js";

export const EMPTY_SNAPSHOT: Snapshot = {
  viewer: null,
  fetchedAt: null,
  auth: "none",
  reviewRequested: [],
  mine: [],
  totals: { reviewRequested: 0, mine: 0 },
  parts: { reviewRequested: { fetchedAt: null }, mine: { fetchedAt: null } },
};

/** The first poll after boot failing waits this long, not a whole interval, before trying again. */
export const BOOT_RETRY_MS = 30_000;

function mergePart(prev: { rows: PrRow[]; total: number; state: PartState }, part: Part, now: string) {
  if (part.ok) return { rows: part.rows, total: part.total, state: { fetchedAt: now } };
  // A failed list keeps its last good rows; only its own error changes.
  return { rows: prev.rows, total: prev.total, state: { fetchedAt: prev.state.fetchedAt, error: part.error } };
}

/** Fold one poll into the last snapshot. */
export function mergeSnapshot(
  prev: Snapshot,
  c: Collected,
  meta: { auth: AuthSource; warning?: string; now: string },
): Snapshot {
  const r = mergePart({ rows: prev.reviewRequested, total: prev.totals.reviewRequested, state: prev.parts.reviewRequested }, c.reviewRequested, meta.now);
  const m = mergePart({ rows: prev.mine, total: prev.totals.mine, state: prev.parts.mine }, c.mine, meta.now);
  const isAuth = (p: Part) => !p.ok && p.error === "auth";
  const snap: Snapshot = {
    viewer: c.viewer ?? prev.viewer,
    fetchedAt: c.reviewRequested.ok || c.mine.ok ? meta.now : prev.fetchedAt,
    auth: meta.auth,
    reviewRequested: r.rows,
    mine: m.rows,
    totals: { reviewRequested: r.total, mine: m.total },
    parts: { reviewRequested: r.state, mine: m.state },
  };
  if (isAuth(c.reviewRequested) || isAuth(c.mine)) snap.error = "auth";
  if (meta.warning) snap.warning = meta.warning;
  return snap;
}

/** A poll where nothing could be fetched at all (no login): both lists fail with the same reason. */
export function failedEverywhere(error: string): Collected {
  return { viewer: null, reviewRequested: { ok: false, error }, mine: { ok: false, error } };
}

/**
 * Wait before the next poll: the interval, except while a list has failed and has never been
 * fetched since boot — then retry in {@link BOOT_RETRY_MS} rather than leave it empty for 15 min.
 */
export function nextDelayMs(s: Snapshot, refreshSec: number): number {
  const neverFetched = (p: PartState) => !!p.error && !p.fetchedAt;
  const boot = neverFetched(s.parts.reviewRequested) || neverFetched(s.parts.mine);
  return boot ? Math.min(BOOT_RETRY_MS, refreshSec * 1000) : refreshSec * 1000;
}
