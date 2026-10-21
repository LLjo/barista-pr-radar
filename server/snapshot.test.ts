import { describe, expect, test } from "bun:test";
import type { Collected } from "./collect.js";
import { BOOT_RETRY_MS, EMPTY_SNAPSHOT, failedEverywhere, mergeSnapshot, nextDelayMs } from "./snapshot.js";
import type { PrRow } from "./types.js";

const row = (id: string) => ({ id, number: 1 }) as PrRow;
const ok = (...ids: string[]) => ({ ok: true as const, rows: ids.map(row), total: ids.length });
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
