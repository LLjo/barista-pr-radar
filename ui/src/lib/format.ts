import type { PrRow } from "./types.js";

/** Compact age: "now", "5m", "2h", "3d", "1w". */
export function age(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (7 * 86400))}w`;
}

/** "synced 1 min ago" wording for the toolbar. */
export function syncedAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "not synced yet";
  const m = Math.floor(Math.max(0, now - Date.parse(iso)) / 60000);
  if (m < 1) return "synced just now";
  if (m < 60) return `synced ${m} min ago`;
  const h = Math.floor(m / 60);
  return `synced ${h} h ago`;
}

/** "owner/name" → ["owner/", "name"] for the group header. */
export function splitRepo(repo: string): [string, string] {
  const i = repo.indexOf("/");
  return i < 0 ? ["", repo] : [repo.slice(0, i + 1), repo.slice(i + 1)];
}

export type ChipKind = "ok" | "bad" | "wait" | "draft";
export interface Chip { kind: ChipKind; label: string; title: string }

/** The status chips on a Mine row, in the mockup's order: conflict, then draft or review. */
export function statusChips(pr: PrRow): Chip[] {
  const out: Chip[] = [];
  if (pr.conflict) out.push({ kind: "bad", label: "⚠ conflict", title: "Merge conflict with the base branch" });
  if (pr.draft) {
    out.push({ kind: "draft", label: "draft", title: "Draft PR" });
    return out;
  }
  const { requested, approved } = pr.reviewers;
  if (pr.review === "approved") out.push({ kind: "ok", label: "✓ approved", title: "Approved" });
  else if (pr.review === "changes") out.push({ kind: "bad", label: "± changes", title: "Changes requested" });
  else if (pr.review === "pending")
    out.push({ kind: "wait", label: requested ? `◷ review ${approved}/${requested}` : "◷ review", title: "Review pending" });
  return out;
}

/** The CI summary under the chips; null when the PR has no checks. */
export function ciLabel(pr: PrRow): { kind: "ok" | "bad" | "wait"; label: string } | null {
  const { state, passed, failed, total } = pr.ci;
  if (state === "ok") return { kind: "ok", label: `● CI ${passed}/${total}` };
  if (state === "failing") return { kind: "bad", label: `✕ CI ${failed} failing` };
  if (state === "running") return { kind: "wait", label: "◌ CI running" };
  return null;
}

export interface RepoGroup { repo: string; rows: PrRow[] }

/**
 * Rows → repo groups, keeping the incoming order: the server already sorts the review list
 * oldest-first and Mine newest-update-first, so a group's first row sets its place.
 */
export function groupByRepo(rows: PrRow[]): RepoGroup[] {
  const groups = new Map<string, PrRow[]>();
  for (const r of rows) {
    const g = groups.get(r.repo);
    if (g) g.push(r);
    else groups.set(r.repo, [r]);
  }
  return [...groups].map(([repo, rows]) => ({ repo, rows }));
}

export type ReviewFilter = "all" | "me" | "teams";
export type MineFilter = "open" | "drafts";
export interface Filters { review: ReviewFilter; mine: MineFilter }

export const FILTERS_KEY = "pr-radar:filters";
export const DEFAULT_FILTERS: Filters = { review: "all", mine: "open" };

export function parseFilters(raw: string | null): Filters {
  try {
    const v = JSON.parse(raw ?? "{}") as Partial<Filters>;
    return {
      review: v.review === "me" || v.review === "teams" ? v.review : "all",
      mine: v.mine === "drafts" ? "drafts" : "open",
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}

export function filterReview(rows: PrRow[], f: ReviewFilter): PrRow[] {
  if (f === "me") return rows.filter((r) => r.via?.kind === "you");
  if (f === "teams") return rows.filter((r) => r.via?.kind === "team");
  return rows;
}

export function filterMine(rows: PrRow[], f: MineFilter): PrRow[] {
  return rows.filter((r) => (f === "drafts" ? r.draft : !r.draft));
}

/**
 * The banner line for a non-auth snapshot error. The server's messages already start with
 * "GitHub …" ("GitHub 502: Bad Gateway"); only a bare one (a network failure) gets the prefix.
 */
export function errorLine(error: string): string {
  return /^GitHub\b/.test(error) ? error : `GitHub: ${error}`;
}

/**
 * A column's empty-state line. With an error and no last good poll the lists are unknown, not
 * empty, so it says so; with last good data the (stale) rows stay and this only covers a real empty.
 */
export function emptyLine(
  column: "review" | "mine",
  s: { loading: boolean; error: boolean; hasData: boolean; filter: ReviewFilter | MineFilter },
): string {
  if (s.loading) return "Loading…";
  if (s.error && !s.hasData) return "Unavailable until GitHub answers.";
  if (column === "review") return s.filter === "all" ? "Nothing waiting on you." : "Nothing here.";
  return s.filter === "drafts" ? "No drafts." : "No open PRs.";
}

/** The line under a column header when GitHub's search came back short (server/snapshot.ts). */
export function partialNote(p: { partial?: boolean; kept?: number }): string | undefined {
  if (!p.partial) return undefined;
  const kept = p.kept ?? 0;
  return kept
    ? `GitHub returned partial results; ${kept} PR${kept === 1 ? "" : "s"} kept from the last sync.`
    : "GitHub returned partial results; some PRs may be missing.";
}

/** A rate-limited list's line, counting down to when the server polls GitHub again. */
export function rateLimitLine(retryAt: string, now = Date.now()): string {
  const min = Math.max(1, Math.ceil((Date.parse(retryAt) - now) / 60_000));
  return `GitHub rate limit, retrying in ${min} min`;
}
