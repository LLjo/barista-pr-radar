import { describe, expect, test } from "bun:test";
import type { Collected, Part } from "./collect.js";
import { createPoller } from "./poll-loop.js";
import type { Settings } from "./types.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const ok: Part = { ok: true, rows: [], total: 0, partial: false };
const limited: Part = { ok: false, error: "GitHub rate limit", retryAt: NOW + 180_000 };

/** A poller on a fake clock and a fake GitHub; `polls` returns one Collected per call, in order. */
function harness(polls: Collected[], refreshSec: Settings["refreshSec"] = 300) {
  const clock = { now: NOW };
  const calls: number[] = [];
  const timers: number[] = [];
  const p = createPoller({
    collect: async () => {
      calls.push(clock.now);
      const next = polls.shift();
      if (!next) throw new Error("unexpected GitHub call");
      return next;
    },
    buildQueries: () => ({ review: "r", direct: "d", mine: "m" }),
    resolveToken: () => ({ token: "t", source: "env" }),
    getSettings: () => ({ orgs: [], repos: [], refreshSec }),
    changed: () => {},
    now: () => clock.now,
    setTimer: (_fn, ms) => {
      timers.push(ms);
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    },
  });
  return { p, clock, calls, timers };
}

describe("settings save during a rate-limit pause", () => {
  test("does not call GitHub, and re-arms the timer at the retry time, not the interval", async () => {
    const { p, clock, calls, timers } = harness([{ viewer: "me", reviewRequested: limited, mine: limited }]);
    await p.poll();
    expect(calls).toEqual([NOW]);

    // One minute into the 3-minute pause the user saves settings (routes.ts: pollFresh, then schedule).
    clock.now = NOW + 60_000;
    await p.pollFresh();
    p.schedule();
    expect(calls).toEqual([NOW]); // GitHub was not asked again
    expect(timers).toEqual([120_000]); // the pause's remaining 2 min, not the 300 s interval
  });

  test("after the pause lifts, a save polls GitHub and the interval applies again", async () => {
    const { p, clock, calls, timers } = harness([
      { viewer: "me", reviewRequested: limited, mine: limited },
      { viewer: "me", reviewRequested: ok, mine: ok },
    ]);
    await p.poll();
    clock.now = NOW + 180_000;
    await p.pollFresh();
    p.schedule();
    expect(calls).toEqual([NOW, NOW + 180_000]);
    expect(timers).toEqual([300_000]);
  });

  test("the header's sync time is the last successful poll, not the rate-limited one", async () => {
    const { p, clock } = harness([
      { viewer: "me", reviewRequested: ok, mine: ok },
      { viewer: null, reviewRequested: limited, mine: limited },
    ]);
    await p.poll();
    clock.now = NOW + 30_000;
    const s = await p.poll();
    expect(s.fetchedAt).toBe(new Date(NOW).toISOString());
  });
});
