import { describe, expect, test } from "bun:test";
import { age, ciLabel, emptyLine, errorLine, partialNote, rateLimitLine, filterMine, filterReview, groupByRepo, parseFilters, splitRepo, statusChips, syncedAgo } from "./format.js";
import type { PrRow } from "./types.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const row = (p: Partial<PrRow>): PrRow => ({
  id: "x", number: 1, title: "t", url: "u", repo: "o/r", author: "a",
  createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", draft: false,
  review: "none", reviewers: { requested: 0, approved: 0 },
  ci: { state: "none", passed: 0, failed: 0, total: 0 }, conflict: false,
  links: { pr: "u", files: "u/files", checks: "u/checks" }, ...p,
});

describe("age", () => {
  test("buckets", () => {
    expect(age("2026-10-21T11:59:30Z", NOW)).toBe("now");
    expect(age("2026-10-21T11:55:00Z", NOW)).toBe("5m");
    expect(age("2026-10-21T10:00:00Z", NOW)).toBe("2h");
    expect(age("2026-10-18T12:00:00Z", NOW)).toBe("3d");
    expect(age("2026-10-14T12:00:00Z", NOW)).toBe("1w");
  });
});

test("syncedAgo", () => {
  expect(syncedAgo(null, NOW)).toBe("not synced yet");
  expect(syncedAgo("2026-10-21T11:59:40Z", NOW)).toBe("synced just now");
  expect(syncedAgo("2026-10-21T11:59:00Z", NOW)).toBe("synced 1 min ago");
});

test("splitRepo", () => {
  expect(splitRepo("LLjo/Barista")).toEqual(["LLjo/", "Barista"]);
});

describe("chips", () => {
  test("conflict before changes, approved, review a/n", () => {
    expect(statusChips(row({ conflict: true, review: "changes" })).map((c) => c.label)).toEqual(["⚠ conflict", "± changes"]);
    expect(statusChips(row({ review: "approved" })).map((c) => c.kind)).toEqual(["ok"]);
    expect(statusChips(row({ review: "pending", reviewers: { requested: 2, approved: 0 } }))[0].label).toBe("◷ review 0/2");
    expect(statusChips(row({ review: "none" }))).toEqual([]);
  });
  test("a draft shows the draft chip instead of the review chip", () => {
    expect(statusChips(row({ draft: true, review: "pending" })).map((c) => c.label)).toEqual(["draft"]);
  });
  test("CI", () => {
    expect(ciLabel(row({ ci: { state: "ok", passed: 12, failed: 0, total: 12 } }))?.label).toBe("● CI 12/12");
    expect(ciLabel(row({ ci: { state: "failing", passed: 1, failed: 2, total: 3 } }))?.label).toBe("✕ CI 2 failing");
    expect(ciLabel(row({ ci: { state: "running", passed: 0, failed: 0, total: 3 } }))?.label).toBe("◌ CI running");
    expect(ciLabel(row({}))).toBeNull();
  });
});

test("groupByRepo keeps the incoming order", () => {
  const g = groupByRepo([row({ id: "1", repo: "a/x" }), row({ id: "2", repo: "b/y" }), row({ id: "3", repo: "a/x" })]);
  expect(g.map((x) => [x.repo, x.rows.map((r) => r.id)])).toEqual([["a/x", ["1", "3"]], ["b/y", ["2"]]]);
});

test("filters", () => {
  const rows = [row({ id: "y", via: { kind: "you" } }), row({ id: "t", via: { kind: "team", team: "@o/t" } })];
  expect(filterReview(rows, "me").map((r) => r.id)).toEqual(["y"]);
  expect(filterReview(rows, "teams").map((r) => r.id)).toEqual(["t"]);
  expect(filterReview(rows, "all")).toHaveLength(2);
  const mine = [row({ id: "o" }), row({ id: "d", draft: true })];
  expect(filterMine(mine, "open").map((r) => r.id)).toEqual(["o"]);
  expect(filterMine(mine, "drafts").map((r) => r.id)).toEqual(["d"]);
  expect(parseFilters('{"review":"me","mine":"drafts"}')).toEqual({ review: "me", mine: "drafts" });
  expect(parseFilters("garbage")).toEqual({ review: "all", mine: "open" });
});

describe("errorLine", () => {
  test("a server message that already says GitHub is shown once", () => {
    expect(errorLine("GitHub 502: Bad Gateway")).toBe("GitHub 502: Bad Gateway");
    expect(errorLine("GitHub returned no data")).toBe("GitHub returned no data");
  });
  test("a bare message gets the prefix", () => {
    expect(errorLine("fetch failed")).toBe("GitHub: fetch failed");
  });
});

describe("emptyLine", () => {
  const base = { loading: false, error: false, hasData: true };
  test("an error with no last good data: unavailable, not empty", () => {
    expect(emptyLine("review", { ...base, error: true, hasData: false, filter: "all" })).toBe("Unavailable until GitHub answers.");
    expect(emptyLine("mine", { ...base, error: true, hasData: false, filter: "open" })).toBe("Unavailable until GitHub answers.");
  });
  test("an error over last good data keeps the real empty states", () => {
    expect(emptyLine("review", { ...base, error: true, filter: "all" })).toBe("Nothing waiting on you.");
    expect(emptyLine("mine", { ...base, error: true, filter: "open" })).toBe("No open PRs.");
  });
  test("loading and filter wording", () => {
    expect(emptyLine("mine", { ...base, loading: true, filter: "open" })).toBe("Loading…");
    expect(emptyLine("review", { ...base, filter: "me" })).toBe("Nothing here.");
    expect(emptyLine("mine", { ...base, filter: "drafts" })).toBe("No drafts.");
  });
});

test("partialNote", () => {
  expect(partialNote({})).toBeUndefined();
  expect(partialNote({ partial: true, kept: 2 })).toBe("GitHub returned partial results; 2 PRs kept from the last sync.");
  expect(partialNote({ partial: true, kept: 1 })).toBe("GitHub returned partial results; 1 PR kept from the last sync.");
  expect(partialNote({ partial: true, kept: 0 })).toBe("GitHub returned partial results; some PRs may be missing.");
});

test("rateLimitLine counts down in whole minutes, never below 1", () => {
  expect(rateLimitLine("2026-10-21T12:03:00Z", NOW)).toBe("GitHub rate limit, retrying in 3 min");
  expect(rateLimitLine("2026-10-21T12:00:20Z", NOW)).toBe("GitHub rate limit, retrying in 1 min");
  expect(rateLimitLine("2026-10-21T11:59:00Z", NOW)).toBe("GitHub rate limit, retrying in 1 min");
});
