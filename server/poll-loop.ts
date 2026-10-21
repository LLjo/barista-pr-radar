import type { Collected } from "./collect.js";
import type { SearchQueries } from "./query.js";
import { EMPTY_SNAPSHOT, failedEverywhere, mergeSnapshot, nextDelayMs, pausedUntil } from "./snapshot.js";
import type { AuthSource, Settings, Snapshot } from "./types.js";

/** Everything the poll loop touches outside itself; poller.ts wires the real ones. */
export interface PollerDeps {
  collect: (q: SearchQueries) => Promise<Collected>;
  buildQueries: (s: Settings) => SearchQueries;
  resolveToken: () => { token: string | null; source: AuthSource };
  getSettings: () => Settings;
  /** Tell the UI the snapshot changed. */
  changed: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}

export function createPoller(deps: PollerDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? setTimeout;
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  let inFlight: Promise<Snapshot> | null = null;
  let rerun: Promise<Snapshot> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function fetchOnce(): Promise<Snapshot> {
    // Rate limited: ↻, a settings save and the timer all wait it out without calling GitHub.
    if (now() < pausedUntil(snapshot)) return snapshot;
    const q = deps.buildQueries(deps.getSettings());
    // Re-resolved on every poll and ↻: a signed-out host is re-asked each time (auth.ts).
    const { token, source } = deps.resolveToken();
    const c = token ? await deps.collect(q) : failedEverywhere("auth");
    for (const [name, part] of [["review", c.reviewRequested], ["mine", c.mine]] as const) {
      if (!part.ok && part.error !== "auth" && !part.retryAt) console.warn(`[pr-radar] ${name} failed:`, part.error);
    }
    return mergeSnapshot(snapshot, c, { auth: source, warning: q.warning, now: new Date(now()).toISOString() });
  }

  /** Poll now. A call while a poll is running joins it rather than starting a second one. */
  function poll(): Promise<Snapshot> {
    inFlight ??= fetchOnce()
      .then((s) => {
        snapshot = s;
        deps.changed();
        return s;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /**
   * Poll with the settings as they are NOW: a running poll may have read the old scope, so
   * wait for it and poll once more. Several saves during one poll share that one rerun.
   */
  function pollFresh(): Promise<Snapshot> {
    if (!inFlight) return poll();
    rerun ??= inFlight.catch(() => undefined).then(() => {
      rerun = null;
      return poll();
    });
    return rerun;
  }

  /** (Re)arm the timer: the interval, the end of a rate-limit pause, or a quick boot retry (snapshot.ts). */
  function schedule(delayMs = nextDelayMs(snapshot, deps.getSettings().refreshSec, now())): void {
    if (timer) clearTimeout(timer);
    timer = setTimer(async () => {
      await poll();
      schedule();
    }, delayMs);
    timer.unref?.();
  }

  return {
    getSnapshot: () => snapshot,
    poll,
    pollFresh,
    schedule,
    async start(): Promise<void> {
      await poll();
      schedule();
    },
    stop(): void {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
