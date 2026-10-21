import { AuthError, graphql, type GitHubDeps } from "./github.js";
import { idsOf, mapMineList, mapReviewList } from "./map.js";
import { DETAILS_QUERY, SEARCH_QUERY, type SearchQueries } from "./query.js";
import type { PrRow } from "./types.js";

interface SearchResult {
  viewer: { login: string };
  result: { issueCount: number; nodes: ({ id?: string } | null)[] };
}

/** One list's outcome: its rows, or why it failed ("auth" when there is no usable login). */
export type Part = { ok: true; rows: PrRow[]; total: number } | { ok: false; error: string };

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
  const search = (query: string) => graphql<SearchResult>(SEARCH_QUERY, { q: query }, deps);
  const details = async (r: SearchResult): Promise<unknown[]> => {
    const ids = idsOf(r.result.nodes);
    if (!ids.length) return [];
    return (await graphql<{ nodes: unknown[] }>(DETAILS_QUERY, { ids }, deps)).nodes;
  };

  const review = search(q.review);
  const direct = search(q.direct);
  const mine = search(q.mine);

  const reviewPart = (async (): Promise<Part> => {
    const [r, d] = await Promise.all([review, direct]);
    return { ok: true, rows: mapReviewList(await details(r), new Set(idsOf(d.result.nodes))), total: r.result.issueCount };
  })().catch(failed);
  const minePart = (async (): Promise<Part> => {
    const m = await mine;
    return { ok: true, rows: mapMineList(await details(m)), total: m.result.issueCount };
  })().catch(failed);

  const [reviewRequested, minePartDone] = await Promise.all([reviewPart, minePart]);
  const viewer = (await Promise.any([review, direct, mine]).catch(() => null))?.viewer.login ?? null;
  return { viewer, reviewRequested, mine: minePartDone };
}
