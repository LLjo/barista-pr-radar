import { describe, expect, test } from "bun:test";
import type { Collected } from "./collect.js";
import { BOOT_RETRY_MS, EMPTY_SNAPSHOT, failedEverywhere, mergeSnapshot, nextDelayMs, pausedUntil } from "./snapshot.js";
import type { PrRow } from "./types.js";

const row = (id: string, p: Partial<PrRow> = {}) =>
  ({ id, number: 1, createdAt: `2026-10-0${id.slice(-1)}T00:00:00Z`, updatedAt: `2026-10-0${id.slice(-1)}T00:00:00Z`, ...p }) as PrRow;
const ok = (...ids: string[]) => ({ ok: true as const, rows: ids.map((id) => row(id)), total: ids.length, partial: false });
const partial = (rows: PrRow[], total = rows.length) => ({ ok: true as const, rows, total, partial: true });
const fail = (error = "GitHub 502: Bad Gateway") => ({ ok: false as const, error });
const meta = (now: string) => ({ auth: "gh" as const, now });
const poll = (reviewRequested: Collected["reviewRequested"], mine: Collected["mine"]): Collected => ({ viewer: "LLjo", reviewRequested, mine });

describe("mergeSnapshot", () => {
  const good = mergeSnapshot(EMPTY_SNAPSHOT, poll(ok("r1"), ok("m1", "m2")), meta("T1"));

  test("a good poll fills both lists", () => {
    expect(good.reviewRequested.map((r) => r.id)).toEqual(["r1"]);
    expect(good.totals).toEqual({ reviewRequested: 1, mine: 2 });
    expect(good.parts).toEqual({ reviewRequested: { fetchedAt: "T1" }, mine: { fetchedAt: "T1" } });
    expect(good.error).toBeUndefined();
  });

  test("(3) one list fails: it keeps its last good rows and carries the error; the other updates", () => {
    const next = mergeSnapshot(good, poll(ok("r2"), fail()), meta("T2"));
    expect(next.reviewRequested.map((r) => r.id)).toEqual(["r2"]);
    expect(next.mine.map((r) => r.id)).toEqual(["m1", "m2"]);
    expect(next.totals.mine).toBe(2);
    expect(next.parts.mine).toEqual({ fetchedAt: "T1", error: "GitHub 502: Bad Gateway" });
    expect(next.parts.reviewRequested).toEqual({ fetchedAt: "T2" });
    expect(next.error).toBeUndefined(); // no page-wide error for one list
    expect(next.fetchedAt).toBe("T2");
  });

  test("the error clears when the list loads again", () => {
    const failed = mergeSnapshot(good, poll(ok("r1"), fail()), meta("T2"));
    expect(mergeSnapshot(failed, poll(ok("r1"), ok("m3")), meta("T3")).parts.mine).toEqual({ fetchedAt: "T3" });
  });

  test("a partial search never drops a PR: last good rows are kept, flagged, in list order", () => {
    const base = mergeSnapshot(EMPTY_SNAPSHOT, poll(ok("r1"), ok("m1", "m2", "m3")), meta("T1"));
    const next = mergeSnapshot(base, poll(ok("r1"), partial([row("m2")], 2)), meta("T2"));
    expect(next.mine.map((r) => r.id)).toEqual(["m3", "m2", "m1"]); // newest update first
    expect(next.parts.mine).toEqual({ fetchedAt: "T2", partial: true, kept: 2 });
    expect(next.totals.mine).toBe(3);
  });

  test("partial with no earlier data: shown, flagged, nothing kept", () => {
    const next = mergeSnapshot(EMPTY_SNAPSHOT, poll(ok(), partial([row("m1")])), meta("T1"));
    expect(next.mine.map((r) => r.id)).toEqual(["m1"]);
    expect(next.parts.mine).toEqual({ fetchedAt: "T1", partial: true, kept: 0 });
  });

  test("a partial review list keeps 'you' when the short direct search lost it", () => {
    const base = mergeSnapshot(EMPTY_SNAPSHOT, poll({ ...ok(), rows: [row("r1", { via: { kind: "you" } })], total: 1 }, ok()), meta("T1"));
    const next = mergeSnapshot(base, poll(partial([row("r1", { via: { kind: "team", team: "a team" } })]), ok()), meta("T2"));
    expect(next.reviewRequested[0].via).toEqual({ kind: "you" });
  });

  test("a complete search after a partial one replaces the list and clears the flag", () => {
    const base = mergeSnapshot(EMPTY_SNAPSHOT, poll(ok(), ok("m1", "m2")), meta("T1"));
    const p = mergeSnapshot(base, poll(ok(), partial([row("m1")])), meta("T2"));
    const done = mergeSnapshot(p, poll(ok(), ok("m1")), meta("T3"));
    expect(done.mine.map((r) => r.id)).toEqual(["m1"]);
    expect(done.parts.mine).toEqual({ fetchedAt: "T3" });
  });

  test("no login: the page-wide auth error, lists kept", () => {
    const next = mergeSnapshot(good, failedEverywhere("auth"), { auth: "none", now: "T2" });
    expect(next.error).toBe("auth");
    expect(next.mine).toHaveLength(2);
    expect(next.fetchedAt).toBe("T1");
  });
});

describe("(4) nextDelayMs", () => {
  test("the first poll after boot failed: retry in 30 s, not a whole interval", () => {
    const s = mergeSnapshot(EMPTY_SNAPSHOT, poll(fail(), fail()), meta("T1"));
    expect(nextDelayMs(s, 900)).toBe(BOOT_RETRY_MS);
    expect(BOOT_RETRY_MS).toBe(30_000);
  });

  test("one list never loaded since boot is enough for the quick retry", () => {
    const s = mergeSnapshot(EMPTY_SNAPSHOT, poll(ok("r1"), fail()), meta("T1"));
    expect(nextDelayMs(s, 300)).toBe(BOOT_RETRY_MS);
  });

  test("no login at boot also retries quickly (picks up a gh auth login)", () => {
    expect(nextDelayMs(mergeSnapshot(EMPTY_SNAPSHOT, failedEverywhere("auth"), { auth: "none", now: "T1" }), 900)).toBe(BOOT_RETRY_MS);
  });

  test("a list that loaded before and fails now waits the normal interval", () => {
    const good = mergeSnapshot(EMPTY_SNAPSHOT, poll(ok("r1"), ok("m1")), meta("T1"));
    expect(nextDelayMs(mergeSnapshot(good, poll(ok("r1"), fail()), meta("T2")), 900)).toBe(900_000);
  });

  test("all good: the interval; never longer than the interval", () => {
    expect(nextDelayMs(mergeSnapshot(EMPTY_SNAPSHOT, poll(ok(), ok()), meta("T1")), 300)).toBe(300_000);
    expect(nextDelayMs(mergeSnapshot(EMPTY_SNAPSHOT, poll(fail(), fail()), meta("T1")), 60)).toBe(30_000);
  });
});

describe("rate-limit pause", () => {
  const NOW = Date.parse("2026-10-21T12:00:00Z");
  const limited = { ok: false as const, error: "GitHub rate limit", retryAt: NOW + 180_000 };
  const good = mergeSnapshot(EMPTY_SNAPSHOT, poll(ok("r1"), ok("m1")), meta("T1"));

  test("a rate-limited list keeps its rows and records when it may try again", () => {
    const s = mergeSnapshot(good, poll(limited, limited), meta("T2"));
    expect(s.mine.map((r) => r.id)).toEqual(["m1"]);
    expect(s.parts.mine).toEqual({ fetchedAt: "T1", error: "GitHub rate limit", retryAt: "2026-10-21T12:03:00.000Z" });
    expect(pausedUntil(s)).toBe(NOW + 180_000);
  });

  test("the next poll waits for the limit to lift, never sooner", () => {
    const s = mergeSnapshot(good, poll(ok("r1"), limited), meta("T2"));
    expect(nextDelayMs(s, 60, NOW)).toBe(180_000); // not the 60 s interval
    expect(nextDelayMs(s, 900, NOW)).toBe(900_000); // a longer interval stays
  });

  test("a good poll after the pause clears it", () => {
    const s = mergeSnapshot(mergeSnapshot(good, poll(limited, limited), meta("T2")), poll(ok("r1"), ok("m1")), meta("T3"));
    expect(pausedUntil(s)).toBe(0);
  });
});
