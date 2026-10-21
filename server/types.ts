/** Global settings, one row per Barista (GitHub identity is per host, not per project). */
export interface Settings {
  orgs: string[];
  /** "name" (expanded per org) or "owner/name". */
  repos: string[];
  refreshSec: RefreshSec;
}

export const REFRESH_CHOICES = [60, 300, 900] as const;
export type RefreshSec = (typeof REFRESH_CHOICES)[number];

export type Via = { kind: "you" } | { kind: "team"; team: string };
export type ReviewState = "approved" | "changes" | "pending" | "none";
export type CiState = "ok" | "failing" | "running" | "none";

export interface PrRow {
  id: string;
  number: number;
  title: string;
  url: string;
  /** "owner/name" */
  repo: string;
  /** Login, "ghost" when GitHub returns no author. */
  author: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  /** Review list only; team = "@org/slug". */
  via?: Via;
  review: ReviewState;
  reviewers: { requested: number; approved: number };
  ci: { state: CiState; passed: number; failed: number; total: number };
  conflict: boolean;
  links: { pr: string; files: string; checks: string };
}

export type AuthSource = "env" | "gh" | "none";

/** One list's fetch state: its own last good fetch since boot, and its own error. */
export interface PartState {
  fetchedAt: string | null;
  error?: string;
  /** GitHub's search returned only some matches this time; `kept` rows come from earlier polls. */
  partial?: boolean;
  kept?: number;
  /** Rate limited: no GitHub calls until this time (ISO); the UI counts down to it. */
  retryAt?: string;
}

export interface Snapshot {
  viewer: string | null;
  /** The last poll where at least one list succeeded. */
  fetchedAt: string | null;
  auth: AuthSource;
  /** "auth" = no GitHub login on the host. A list's own failure is in `parts`, not here. */
  error?: string;
  warning?: string;
  reviewRequested: PrRow[];
  mine: PrRow[];
  /** GitHub's issueCount, which may exceed the 50 rows shown. */
  totals: { reviewRequested: number; mine: number };
  parts: { reviewRequested: PartState; mine: PartState };
}
