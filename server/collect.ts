import { AuthError, graphql, searchIssues, type GitHubDeps, type SearchHit } from "./github.js";
import { mapMineList, mapReviewList } from "./map.js";
import { DETAILS_QUERY, type SearchQueries } from "./query.js";
import type { PrRow } from "./types.js";

/**
 * One list's outcome: its rows, or why it failed ("auth" when there is no usable login).
 * `partial`: GitHub's search said it returned only some matches (snapshot.ts keeps the rest).
 */
export type Part = { ok: true; rows: PrRow[]; total: number; partial: boolean } | { ok: false; error: string };

export interface Collected {
  viewer: string | null;
  reviewRequested: Part;
  mine: Part;
}

const failed = (err: unknown): Part => ({ ok: false, error: err instanceof AuthError ? "auth" : (err as Error).message });

/**
 * One poll. The three searches (review, direct, mine) go out in parallel, ids only, then each
 * list's details in one `nodes(ids:)` lookup. Each request is retried on its own (github.ts), and
 * a list that still fails fails alone: the other list's rows come back regardless.
 */
export async function collect(q: SearchQueries, deps?: GitHubDeps): Promise<Collected> {
  let viewer: string | null = null;
  const details = async (hit: SearchHit): Promise<unknown[]> => {
    if (!hit.ids.length) return [];
    const d = await graphql<{ viewer: { login: string }; nodes: unknown[] }>(DETAILS_QUERY, { ids: hit.ids }, deps);
    viewer ??= d.viewer.login;
    return d.nodes;
  };

  const review = searchIssues(q.review, deps);
  const direct = searchIssues(q.direct, deps);
  const mine = searchIssues(q.mine, deps);

  const reviewPart = (async (): Promise<Part> => {
    const [r, d] = await Promise.all([review, direct]);
    // A partial direct search could call a "you" request a team one, so it marks the list partial too.
    const rows = mapReviewList(await details(r), new Set(d.ids));
    return { ok: true, rows, total: r.total, partial: r.incomplete || d.incomplete };
  })().catch(failed);
  const minePart = (async (): Promise<Part> => {
    const m = await mine;
    return { ok: true, rows: mapMineList(await details(m)), total: m.total, partial: m.incomplete };
  })().catch(failed);

  const [reviewRequested, mineDone] = await Promise.all([reviewPart, minePart]);
  return { viewer, reviewRequested, mine: mineDone };
}
