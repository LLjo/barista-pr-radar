import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/response.json";
import { collect } from "./collect.js";
import type { GitHubDeps } from "./github.js";
import { buildSearchQueries } from "./query.js";

type Kind = "review" | "direct" | "mine" | "details";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const allPrs = [...fixture.review.nodes, ...fixture.mine.nodes] as { id?: string }[];

/** Which request a mocked fetch got: a details lookup, or one of the three searches. */
function kindOf(query: string, vars: Record<string, unknown>): Kind {
  if (query.includes("nodes(ids:")) return "details";
  const q = String(vars.q);
  return q.includes("user-review-requested") ? "direct" : q.includes("review-requested") ? "review" : "mine";
}

function searchAnswer(kind: Exclude<Kind, "details">) {
  const nodes = kind === "direct" ? fixture.direct.nodes : kind === "review" ? fixture.review.nodes : fixture.mine.nodes;
  return json(200, { data: { viewer: { login: "LLjo" }, result: { issueCount: nodes.filter((n) => "id" in n).length, nodes } } });
}

/**
 * A mocked GitHub. `failing` kinds answer 502 every time. With `barrier`, no search is answered
 * until all three have arrived: if they were sent one after another, the poll would hang.
 */
function mockGitHub(opts: { failing?: Kind[]; barrier?: boolean } = {}) {
  const log: Kind[] = [];
  let release: () => void = () => {};
  const allThree = new Promise<void>((r) => (release = r));
  let searches = 0;
  const deps: GitHubDeps = {
    post: async (_t, query, vars) => {
      const kind = kindOf(query, vars);
      log.push(kind);
      if (kind !== "details" && opts.barrier) {
        if (++searches === 3) release();
        await allThree;
      }
      if (opts.failing?.includes(kind)) return json(502, { message: "Bad Gateway" });
      if (kind === "details") {
        const ids = vars.ids as string[];
        return json(200, { data: { nodes: ids.map((id) => allPrs.find((p) => p.id === id) ?? null) } });
      }
      return searchAnswer(kind);
    },
    token: () => "gho_x",
    invalidate: () => {},
    sleep: async () => {},
  };
  return { deps, log };
}

const q = buildSearchQueries({ orgs: ["LLjo", "StayLive"], repos: [] });

describe("collect", () => {
  test("(1) the three searches go out in parallel, then one details lookup per list", async () => {
    const gh = mockGitHub({ barrier: true });
    const c = await Promise.race([
      collect(q, gh.deps),
      new Promise<never>((_, no) => setTimeout(() => no(new Error("searches were sent one after another")), 500)),
    ]);
    expect(gh.log.slice(0, 3).sort()).toEqual(["direct", "mine", "review"]);
    expect(gh.log.filter((k) => k === "details")).toHaveLength(2);
    expect(c.viewer).toBe("LLjo");
    expect(c.reviewRequested.ok && c.reviewRequested.rows.map((r) => [r.number, r.via?.kind])).toEqual([[1226, "you"], [391, "team"], [873, "team"]]);
    expect(c.mine.ok && c.mine.rows.map((r) => r.number)).toEqual([2201, 2190]);
  });

  test("(2) each request is retried once: a single 502 does not fail the list", async () => {
    let first = true;
    const gh = mockGitHub();
    const post = gh.deps.post;
    gh.deps.post = async (t, query, vars) => {
      if (first && kindOf(query, vars) === "mine") { first = false; return json(502, {}); }
      return post(t, query, vars);
    };
    const c = await collect(q, gh.deps);
    expect(c.mine.ok).toBe(true);
  });

  test("(3) a list that still fails fails alone; the other list's rows come back", async () => {
    const gh = mockGitHub({ failing: ["mine"] });
    const c = await collect(q, gh.deps);
    expect(c.reviewRequested.ok).toBe(true);
    expect(c.mine).toEqual({ ok: false, error: "GitHub 502: Bad Gateway" });
    expect(gh.log.filter((k) => k === "mine")).toHaveLength(2); // tried, retried, given up
  });

  test("(3) a failing direct search fails the review list only", async () => {
    const c = await collect(q, mockGitHub({ failing: ["direct"] }).deps);
    expect(c.reviewRequested.ok).toBe(false);
    expect(c.mine.ok).toBe(true);
  });

  test("no ids: no details lookup", async () => {
    const gh = mockGitHub();
    const post = gh.deps.post;
    gh.deps.post = async (t, query, vars) =>
      kindOf(query, vars) === "details" ? post(t, query, vars)
      : json(200, { data: { viewer: { login: "LLjo" }, result: { issueCount: 0, nodes: [] } } });
    const c = await collect(q, gh.deps);
    expect(gh.log.includes("details")).toBe(false);
    expect(c.mine).toEqual({ ok: true, rows: [], total: 0 });
  });
});
