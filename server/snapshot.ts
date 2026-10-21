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

const byOldest = (a: PrRow, b: PrRow) => a.createdAt.localeCompare(b.createdAt);
const byNewestUpdate = (a: PrRow, b: PrRow) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * GitHub's search said it returned only some matches: never drop a PR because of that. Keep the
 * previous rows this poll is missing (a PR closed meanwhile lingers until a complete search), and
 * a "you" request stays "you" when only the direct search came back short.
 */
function unionPartial(prev: PrRow[], fresh: PrRow[], order: (a: PrRow, b: PrRow) => number): { rows: PrRow[]; kept: number } {
  const prevById = new Map(prev.map((r) => [r.id, r]));
  const freshIds = new Set(fresh.map((r) => r.id));
  const merged = fresh.map((r) => (prevById.get(r.id)?.via?.kind === "you" && r.via?.kind === "team" ? { ...r, via: { kind: "you" as const } } : r));
  const kept = prev.filter((r) => !freshIds.has(r.id));
  return { rows: [...merged, ...kept].sort(order), kept: kept.length };
}

function mergePart(
  prev: { rows: PrRow[]; total: number; state: PartState },
  part: Part,
  now: string,
  order: (a: PrRow, b: PrRow) => number,
) {
  if (part.ok && part.partial) {
    const { rows, kept } = unionPartial(prev.rows, part.rows, order);
    return { rows, total: Math.max(part.total, rows.length), state: { fetchedAt: now, partial: true, kept } };
  }
  if (part.ok) return { rows: part.rows, total: part.total, state: { fetchedAt: now } };
  // A failed list keeps its last good rows; only its own error changes.
  const state: PartState = { fetchedAt: prev.state.fetchedAt, error: part.error };
  if (part.retryAt) state.retryAt = new Date(part.retryAt).toISOString();
  return { rows: prev.rows, total: prev.total, state };
}

/** Fold one poll into the last snapshot. */
export function mergeSnapshot(
  prev: Snapshot,
  c: Collected,
  meta: { auth: AuthSource; warning?: string; now: string },
): Snapshot {
  const r = mergePart({ rows: prev.reviewRequested, total: prev.totals.reviewRequested, state: prev.parts.reviewRequested }, c.reviewRequested, meta.now, byOldest);
  const m = mergePart({ rows: prev.mine, total: prev.totals.mine, state: prev.parts.mine }, c.mine, meta.now, byNewestUpdate);
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

/** Rate limited: the time (epoch ms) before which no list may call GitHub, or 0. */
export function pausedUntil(s: Snapshot): number {
  const at = (p: PartState) => (p.retryAt ? Date.parse(p.retryAt) : 0);
  return Math.max(at(s.parts.reviewRequested), at(s.parts.mine));
}

/**
 * Wait before the next poll. Rate limited: exactly until the limit lifts — not sooner, and not a
 * whole interval later either (a settings save during the pause re-arms here too). Otherwise the
 * interval, except while a list has failed and has never been fetched since boot — then retry in
 * {@link BOOT_RETRY_MS} rather than leave it empty for 15 min.
 */
export function nextDelayMs(s: Snapshot, refreshSec: number, now = Date.now()): number {
  const paused = pausedUntil(s) - now;
  if (paused > 0) return paused;
  const neverFetched = (p: PartState) => !!p.error && !p.fetchedAt;
  const boot = neverFetched(s.parts.reviewRequested) || neverFetched(s.parts.mine);
  return boot ? Math.min(BOOT_RETRY_MS, refreshSec * 1000) : refreshSec * 1000;
}
