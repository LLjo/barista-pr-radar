import { nats } from "@barista/plugin-sdk";
import { resolveToken } from "./auth.js";
import { collect } from "./collect.js";
import { buildSearchQueries } from "./query.js";
import { getSettings } from "./settings.js";
import { EMPTY_SNAPSHOT, failedEverywhere, mergeSnapshot, nextDelayMs, pausedUntil } from "./snapshot.js";
import { subjects } from "./subjects.js";
import type { Snapshot } from "./types.js";

let snapshot: Snapshot = EMPTY_SNAPSHOT;
let inFlight: Promise<Snapshot> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function getSnapshot(): Snapshot {
  return snapshot;
}

async function fetchOnce(): Promise<Snapshot> {
  // Rate limited: ↻, a settings save and the timer all wait it out without calling GitHub.
  if (Date.now() < pausedUntil(snapshot)) return snapshot;
  const q = buildSearchQueries(getSettings());
  // Re-resolved on every poll and ↻: a signed-out host is re-asked each time (auth.ts).
  const { token, source } = resolveToken();
  const c = token ? await collect(q) : failedEverywhere("auth");
  for (const [name, part] of [["review", c.reviewRequested], ["mine", c.mine]] as const) {
    if (!part.ok && part.error !== "auth" && !part.retryAt) console.warn(`[pr-radar] ${name} failed:`, part.error);
  }
  return mergeSnapshot(snapshot, c, { auth: source, warning: q.warning, now: new Date().toISOString() });
}

/** Poll now. A call while a poll is running joins it rather than starting a second one. */
export function poll(): Promise<Snapshot> {
  inFlight ??= fetchOnce()
    .then((s) => {
      snapshot = s;
      nats.publish(subjects.changed, undefined);
      return s;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

let rerun: Promise<Snapshot> | null = null;

/**
 * Poll with the settings as they are NOW: a running poll may have read the old scope, so
 * wait for it and poll once more. Several saves during one poll share that one rerun.
 */
export function pollFresh(): Promise<Snapshot> {
  if (!inFlight) return poll();
  rerun ??= inFlight.catch(() => undefined).then(() => {
    rerun = null;
    return poll();
  });
  return rerun;
}

/** (Re)arm the timer: the interval, or a quick retry while a list has never loaded (snapshot.ts). */
export function schedule(delayMs = nextDelayMs(snapshot, getSettings().refreshSec)): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await poll();
    schedule();
  }, delayMs);
  timer.unref?.();
}

export async function startPoller(): Promise<void> {
  await poll();
  schedule();
}

export function stopPoller(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
