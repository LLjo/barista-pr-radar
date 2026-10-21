import type { Settings } from "./types.js";

/** GitHub rejects search strings longer than this. */
export const SEARCH_MAX = 256;

const BASE = "is:pr is:open archived:false";

export interface SearchQueries {
  review: string;
  direct: string;
  mine: string;
  /** Set when scope qualifiers had to be dropped to fit {@link SEARCH_MAX}. */
  warning?: string;
}

/**
 * The scope qualifiers every search shares: one `repo:` per filter entry (a bare name expands
 * per org), else one `org:` per org, else nothing (all of GitHub). Search ORs repeats.
 */
export function scopeQualifiers(s: Pick<Settings, "orgs" | "repos">): string[] {
  if (s.repos.length) {
    const out: string[] = [];
    for (const r of s.repos) {
      if (r.includes("/")) out.push(`repo:${r}`);
      else for (const org of s.orgs) out.push(`repo:${org}/${r}`);
    }
    return [...new Set(out)];
  }
  return s.orgs.map((o) => `org:${o}`);
}

/** Append qualifiers to `head` until the next one would overflow; returns how many fit. */
function fit(head: string, quals: string[]): { q: string; used: number } {
  let q = head;
  let used = 0;
  for (const qual of quals) {
    if (q.length + 1 + qual.length > SEARCH_MAX) break;
    q += ` ${qual}`;
    used++;
  }
  return { q, used };
}

export function buildSearchQueries(s: Pick<Settings, "orgs" | "repos">): SearchQueries {
  const quals = scopeQualifiers(s);
  const heads = {
    review: `${BASE} review-requested:@me`,
    direct: `${BASE} user-review-requested:@me`,
    mine: `${BASE} author:@me`,
  };
  // The three searches share one scope, so cut it to what fits the longest head.
  const longest = Object.values(heads).reduce((a, b) => (b.length > a.length ? b : a));
  const kept = quals.slice(0, fit(longest, quals).used);
  const out: SearchQueries = {
    review: fit(heads.review, kept).q,
    direct: fit(heads.direct, kept).q,
    mine: fit(heads.mine, kept).q,
  };
  if (kept.length < quals.length) {
    const dropped = quals.slice(kept.length);
    out.warning = `Search too long for GitHub: ignored ${dropped.length} of ${quals.length} filters (${dropped.join(" ")}).`;
  }
  return out;
}

/** One call per poll; verified against api.github.com on 2026-10-21 (cost 4). */
export const GRAPHQL = `query($rq:String!,$direct:String!,$mine:String!){
  viewer{login}
  rateLimit{cost remaining resetAt}
  review: search(type:ISSUE, query:$rq, first:50){ issueCount nodes{...Pr} }
  direct: search(type:ISSUE, query:$direct, first:50){ nodes{... on PullRequest{id}} }
  mine: search(type:ISSUE, query:$mine, first:50){ issueCount nodes{...Pr} }
}
fragment Pr on PullRequest {
  id number title url isDraft createdAt updatedAt
  author{login}
  repository{nameWithOwner}
  reviewDecision mergeable
  reviewRequests(first:10){ totalCount nodes{ requestedReviewer{ __typename ... on User{login} ... on Team{slug organization{login}} } } }
  latestOpinionatedReviews(first:10){ nodes{ state author{login} } }
  commits(last:1){ nodes{ commit{ statusCheckRollup{ state contexts(first:0){ totalCount checkRunCountsByState{state count} statusContextCountsByState{state count} } } } } }
}`;
