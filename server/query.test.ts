import { describe, expect, test } from "bun:test";
import { buildSearchQueries, scopeQualifiers, SEARCH_MAX } from "./query.js";

const BASE = "is:pr is:open archived:false";

describe("scopeQualifiers", () => {
  test("no orgs and no repos: no scope (all of GitHub)", () => {
    expect(scopeQualifiers({ orgs: [], repos: [] })).toEqual([]);
  });

  test("orgs only: one org: per org", () => {
    expect(scopeQualifiers({ orgs: ["LLjo", "twocircles"], repos: [] })).toEqual(["org:LLjo", "org:twocircles"]);
  });

  test("repo filter replaces org:, bare names expand per org, owner/name is kept", () => {
    expect(scopeQualifiers({ orgs: ["a", "b"], repos: ["web", "c/infra"] })).toEqual([
      "repo:a/web",
      "repo:b/web",
      "repo:c/infra",
    ]);
  });

  test("a bare repo with no orgs expands to nothing", () => {
    expect(scopeQualifiers({ orgs: [], repos: ["web", "x/y"] })).toEqual(["repo:x/y"]);
  });

  test("duplicate expansions collapse", () => {
    expect(scopeQualifiers({ orgs: ["a"], repos: ["web", "a/web"] })).toEqual(["repo:a/web"]);
  });
});

describe("buildSearchQueries", () => {
  test("three searches over the same scope", () => {
    const q = buildSearchQueries({ orgs: ["LLjo"], repos: [] });
    expect(q.review).toBe(`${BASE} review-requested:@me org:LLjo`);
    expect(q.direct).toBe(`${BASE} user-review-requested:@me org:LLjo`);
    expect(q.mine).toBe(`${BASE} author:@me org:LLjo`);
    expect(q.warning).toBeUndefined();
  });

  test("no scope at all", () => {
    const q = buildSearchQueries({ orgs: [], repos: [] });
    expect(q.mine).toBe(`${BASE} author:@me`);
  });

  test("caps every search at 256 chars, drops the same qualifiers from all three and warns", () => {
    const orgs = Array.from({ length: 10 }, (_, i) => `org-number-${i}-padding`);
    const repos = Array.from({ length: 20 }, (_, i) => `repository-${i}`);
    const q = buildSearchQueries({ orgs, repos });
    for (const s of [q.review, q.direct, q.mine]) expect(s.length).toBeLessThanOrEqual(SEARCH_MAX);
    const scope = (s: string) => s.split(" ").filter((t) => t.startsWith("repo:"));
    expect(scope(q.review)).toEqual(scope(q.direct));
    expect(scope(q.mine)).toEqual(scope(q.direct));
    expect(scope(q.direct).length).toBeGreaterThan(0);
    expect(q.warning).toContain("ignored");
  });

  test("ten max-length orgs still fit or warn, never overflow", () => {
    const orgs = Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(39, "x"));
    const q = buildSearchQueries({ orgs, repos: [] });
    expect(q.direct.length).toBeLessThanOrEqual(SEARCH_MAX);
    expect(q.warning).toBeDefined();
  });
});
