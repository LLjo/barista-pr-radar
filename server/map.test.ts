import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/response.json";
import { mapCi, mapPr, mapResponse, mapReview, mapVia, type GqlData, type GqlPr, type GqlRollup } from "./map.js";

const data = fixture as unknown as GqlData;
const rollup = (state: GqlRollup["state"], runs: [string, number][] = [], statuses: [string, number][] = [], total = 0): GqlRollup => ({
  state,
  contexts: {
    totalCount: total,
    checkRunCountsByState: runs.map(([state, count]) => ({ state, count })),
    statusContextCountsByState: statuses.map(([state, count]) => ({ state, count })),
  },
});
const reviews = (...states: string[]) => ({ nodes: states.map((state) => ({ state, author: { login: "x" } })) });
const requests = (totalCount: number) => ({ totalCount, nodes: [] });

describe("mapReview", () => {
  test("reviewDecision wins when set", () => {
    expect(mapReview({ reviewDecision: "APPROVED", latestOpinionatedReviews: reviews("CHANGES_REQUESTED"), reviewRequests: requests(0) })).toBe("approved");
    expect(mapReview({ reviewDecision: "CHANGES_REQUESTED", latestOpinionatedReviews: null, reviewRequests: null })).toBe("changes");
    expect(mapReview({ reviewDecision: "REVIEW_REQUIRED", latestOpinionatedReviews: null, reviewRequests: null })).toBe("pending");
  });

  test("null decision: derived from reviews, changes beat approvals", () => {
    expect(mapReview({ reviewDecision: null, latestOpinionatedReviews: reviews("APPROVED", "CHANGES_REQUESTED"), reviewRequests: requests(0) })).toBe("changes");
    expect(mapReview({ reviewDecision: null, latestOpinionatedReviews: reviews("APPROVED", "COMMENTED"), reviewRequests: requests(0) })).toBe("approved");
    expect(mapReview({ reviewDecision: null, latestOpinionatedReviews: reviews(), reviewRequests: requests(2) })).toBe("pending");
    expect(mapReview({ reviewDecision: null, latestOpinionatedReviews: reviews(), reviewRequests: requests(0) })).toBe("none");
  });
});

describe("mapCi", () => {
  test("no rollup is none", () => {
    expect(mapCi(null)).toEqual({ state: "none", passed: 0, failed: 0, total: 0 });
  });

  test("SUCCESS counts success, neutral and skipped runs plus success statuses", () => {
    expect(mapCi(rollup("SUCCESS", [["SUCCESS", 5], ["NEUTRAL", 1], ["SKIPPED", 2]], [["SUCCESS", 1]], 9)))
      .toEqual({ state: "ok", passed: 9, failed: 0, total: 9 });
  });

  test("FAILURE and ERROR are failing; every failing run state counts", () => {
    const runs: [string, number][] = [["FAILURE", 1], ["TIMED_OUT", 1], ["CANCELLED", 1], ["STARTUP_FAILURE", 1], ["ACTION_REQUIRED", 1], ["SUCCESS", 2]];
    expect(mapCi(rollup("FAILURE", runs, [["FAILURE", 1], ["ERROR", 1]], 9))).toEqual({ state: "failing", passed: 2, failed: 7, total: 9 });
    expect(mapCi(rollup("ERROR", [], [["ERROR", 1]], 1)).state).toBe("failing");
  });

  test("PENDING and EXPECTED are running", () => {
    expect(mapCi(rollup("PENDING", [["IN_PROGRESS", 2]], [], 2)).state).toBe("running");
    expect(mapCi(rollup("EXPECTED")).state).toBe("running");
  });

  test("null count arrays are zero", () => {
    expect(mapCi({ state: "SUCCESS", contexts: { totalCount: 0, checkRunCountsByState: null, statusContextCountsByState: null } }))
      .toEqual({ state: "ok", passed: 0, failed: 0, total: 0 });
  });
});

describe("mapVia", () => {
  const team = { __typename: "Team", slug: "platform", organization: { login: "twocircles" } };
  test("in the direct search: you, even when a team is also requested", () => {
    expect(mapVia({ id: "1", reviewRequests: { totalCount: 1, nodes: [{ requestedReviewer: team }] } }, new Set(["1"]))).toEqual({ kind: "you" });
  });
  test("not direct: the first team, as @org/slug", () => {
    const nodes = [{ requestedReviewer: { __typename: "User", login: "u" } }, { requestedReviewer: team }];
    expect(mapVia({ id: "1", reviewRequests: { totalCount: 2, nodes } }, new Set())).toEqual({ kind: "team", team: "@twocircles/platform" });
  });
  test("not direct and no team listed: 'a team'", () => {
    expect(mapVia({ id: "1", reviewRequests: { totalCount: 0, nodes: [] } }, new Set())).toEqual({ kind: "team", team: "a team" });
  });
});

describe("mapPr", () => {
  const node = data.mine.nodes[1] as GqlPr;
  test("links, conflict, reviewers and a mine row has no via", () => {
    const row = mapPr(node);
    expect(row.links).toEqual({ pr: node.url, files: `${node.url}/files`, checks: `${node.url}/checks` });
    expect(row.conflict).toBe(true);
    expect(row.reviewers).toEqual({ requested: 2, approved: 1 });
    expect(row.ci).toEqual({ state: "failing", passed: 3, failed: 3, total: 6 });
    expect(row.via).toBeUndefined();
  });
  test("UNKNOWN mergeable is not a conflict; null author is ghost", () => {
    const row = mapPr(data.review.nodes[1] as GqlPr, new Set());
    expect(row.conflict).toBe(false);
    expect(row.author).toBe("ghost");
  });
});

describe("mapResponse", () => {
  const out = mapResponse(data);
  test("review list: oldest request first, non-PR nodes dropped, via set", () => {
    expect(out.reviewRequested.map((r) => r.number)).toEqual([1226, 391, 873]);
    expect(out.reviewRequested.map((r) => r.via)).toEqual([
      { kind: "you" },
      { kind: "team", team: "@twocircles/platform" },
      { kind: "team", team: "a team" },
    ]);
  });
  test("mine: most recently updated first, draft flag kept", () => {
    expect(out.mine.map((r) => [r.number, r.draft])).toEqual([[2201, false], [2190, true]]);
  });
  test("viewer and totals from issueCount", () => {
    expect(out.viewer).toBe("LLjo");
    expect(out.totals).toEqual({ reviewRequested: 3, mine: 2 });
  });
});
