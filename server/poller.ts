import { nats } from "@barista/plugin-sdk";
import { githubAuthSource } from "@barista/types/github-auth";
import { AuthError, graphql } from "./github.js";
import { mapResponse, type GqlData } from "./map.js";
import { buildSearchQueries, GRAPHQL } from "./query.js";
import { getSettings } from "./settings.js";
import { subjects } from "./subjects.js";
import type { Snapshot } from "./types.js";

let snapshot: Snapshot = {
  viewer: null,
  fetchedAt: null,
  auth: "none",
  reviewRequested: [],
  mine: [],
  totals: { reviewRequested: 0, mine: 0 },
};
let inFlight: Promise<Snapshot> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function getSnapshot(): Snapshot {
  return snapshot;
}

async function fetchOnce(): Promise<Snapshot> {
  const settings = getSettings();
  const q = buildSearchQueries(settings);
  const base = { auth: githubAuthSource(), warning: q.warning };
  try {
    const data = await graphql<GqlData>(GRAPHQL, { rq: q.review, direct: q.direct, mine: q.mine });
    return { ...mapResponse(data), ...base, fetchedAt: new Date().toISOString() };
  } catch (err) {
    // A failed poll keeps the last good lists; only the error changes.
    const error = err instanceof AuthError ? "auth" : (err as Error).message;
    if (!(err instanceof AuthError)) console.warn("[pr-radar] poll failed:", error);
    return { ...snapshot, ...base, error };
  }
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

/** (Re)arm the interval from the current settings; called on boot and after a settings save. */
export function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    await poll();
    schedule();
  }, getSettings().refreshSec * 1000);
  timer.unref?.();
}

export function startPoller(): void {
  void poll();
  schedule();
}

export function stopPoller(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
