import type { CiState, PrRow, ReviewState, Via } from "./types.js";

/** The slice of the GraphQL `Pr` fragment this module reads (see query.ts). */
export interface GqlPr {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewRequests: {
    totalCount: number;
    nodes: { requestedReviewer: GqlReviewer | null }[];
  } | null;
  latestOpinionatedReviews: { nodes: { state: string; author: { login: string } | null }[] } | null;
  commits: { nodes: { commit: { statusCheckRollup: GqlRollup | null } }[] } | null;
}

export type GqlReviewer =
  | { __typename: "User"; login: string }
  | { __typename: "Team"; slug: string; organization: { login: string } }
  | { __typename: string };

interface StateCount { state: string; count: number }

export interface GqlRollup {
  state: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED";
  contexts: {
    totalCount: number;
    checkRunCountsByState: StateCount[] | null;
    statusContextCountsByState: StateCount[] | null;
  };
}

const RUN_FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);
const RUN_PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const STATUS_FAILED = new Set(["FAILURE", "ERROR"]);
const STATUS_PASSED = new Set(["SUCCESS"]);

function sum(counts: StateCount[] | null | undefined, states: Set<string>): number {
  return (counts ?? []).reduce((n, c) => (states.has(c.state) ? n + c.count : n), 0);
}

export function mapCi(rollup: GqlRollup | null | undefined): PrRow["ci"] {
  if (!rollup) return { state: "none", passed: 0, failed: 0, total: 0 };
  const { checkRunCountsByState: runs, statusContextCountsByState: statuses, totalCount } = rollup.contexts;
  const state: CiState =
    rollup.state === "SUCCESS" ? "ok"
    : rollup.state === "FAILURE" || rollup.state === "ERROR" ? "failing"
    : rollup.state === "PENDING" || rollup.state === "EXPECTED" ? "running"
    : "none";
  return {
    state,
    passed: sum(runs, RUN_PASSED) + sum(statuses, STATUS_PASSED),
    failed: sum(runs, RUN_FAILED) + sum(statuses, STATUS_FAILED),
    total: totalCount,
  };
}

export function mapReview(pr: Pick<GqlPr, "reviewDecision" | "latestOpinionatedReviews" | "reviewRequests">): ReviewState {
  switch (pr.reviewDecision) {
    case "APPROVED": return "approved";
    case "CHANGES_REQUESTED": return "changes";
    case "REVIEW_REQUIRED": return "pending";
  }
  // No branch protection: GitHub gives no decision, so derive one from the reviews.
  const states = (pr.latestOpinionatedReviews?.nodes ?? []).map((r) => r.state);
  if (states.includes("CHANGES_REQUESTED")) return "changes";
  if (states.includes("APPROVED")) return "approved";
  return (pr.reviewRequests?.totalCount ?? 0) > 0 ? "pending" : "none";
}

/** "you" when the PR came back from the direct-request search, else the first requested team. */
export function mapVia(pr: Pick<GqlPr, "id" | "reviewRequests">, directIds: Set<string>): Via {
  if (directIds.has(pr.id)) return { kind: "you" };
  for (const n of pr.reviewRequests?.nodes ?? []) {
    const r = n.requestedReviewer;
    if (r && r.__typename === "Team" && "slug" in r) return { kind: "team", team: `@${r.organization.login}/${r.slug}` };
  }
  return { kind: "team", team: "a team" };
}

export function mapPr(pr: GqlPr, directIds?: Set<string>): PrRow {
  const approved = (pr.latestOpinionatedReviews?.nodes ?? []).filter((r) => r.state === "APPROVED").length;
  const row: PrRow = {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repo: pr.repository.nameWithOwner,
    author: pr.author?.login ?? "ghost",
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    draft: pr.isDraft,
    review: mapReview(pr),
    reviewers: { requested: (pr.reviewRequests?.totalCount ?? 0) + approved, approved },
    ci: mapCi(pr.commits?.nodes?.[0]?.commit.statusCheckRollup),
    conflict: pr.mergeable === "CONFLICTING",
    links: { pr: pr.url, files: `${pr.url}/files`, checks: `${pr.url}/checks` },
  };
  if (directIds) row.via = mapVia(pr, directIds);
  return row;
}

/** Search nodes can be empty objects for non-PR hits; keep the real PRs only. */
function prsOf(nodes: unknown[] | undefined): GqlPr[] {
  return (nodes ?? []).filter((n): n is GqlPr => !!n && typeof (n as GqlPr).id === "string" && typeof (n as GqlPr).number === "number");
}

export interface GqlData {
  viewer: { login: string };
  review: { issueCount: number; nodes: unknown[] };
  direct: { nodes: ({ id?: string } | null)[] };
  mine: { issueCount: number; nodes: unknown[] };
}

/** The whole response → both lists, ordered: review oldest-first, mine most recently updated first. */
export function mapResponse(data: GqlData): {
  viewer: string;
  reviewRequested: PrRow[];
  mine: PrRow[];
  totals: { reviewRequested: number; mine: number };
} {
  const directIds = new Set(data.direct.nodes.map((n) => n?.id).filter((id): id is string => !!id));
  const reviewRequested = prsOf(data.review.nodes)
    .map((p) => mapPr(p, directIds))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const mine = prsOf(data.mine.nodes)
    .map((p) => mapPr(p))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    viewer: data.viewer.login,
    reviewRequested,
    mine,
    totals: { reviewRequested: data.review.issueCount, mine: data.mine.issueCount },
  };
}
