# Issue #1239: build PR Radar from the approved mockup

Branch `feat/issue-1239-build` (off `design/issue-1238`) in LLjo/barista-pr-radar. Barista itself
gets no commits (spec acceptance 10), so this worklog lives here.

## Done
- Scaffolded via `scripts/create-plugin.ts --dir /tmp/prr` (its `bun install` fails outside the
  repo: `file:../../shared` paths; harmless, files copied over), dropped the items sample and tailwind.
- Server: settings (SQLite row), query.ts (scope qualifiers, 256 cap, same scope cut on all three
  searches), map.ts, github.ts (401 → invalidate + retry once), poller (one in flight, last good
  snapshot kept, NATS `changed`), routes. 24 server tests + 8 UI format tests.
- UI: Toolbar / Column / PrRow + format.ts; api.ts uses plain fetch, not `hc<AppType>` (that
  drags server modules into svelte-check).
- Live GraphQL check against github.com with org LLjo: cost 4, lists map correctly.
- Side stack (instance 1): enabled, settings persist across restart, repo filter, 400 on bad body; UI screenshot matches mockup; auth banner + filters checked with a mocked snapshot.
- Settings save during a running poll now reruns after it (`pollFresh`) instead of joining the stale-scope poll.
- Fix round 1: the SDK token helper caches a null for 30 min, so the auth banner stayed up after `gh auth login`. server/auth.ts resolveToken() never keeps a cached null (re-probe, then invalidate); poller + github.ts use it. Real-gh check: SDK alone stays null after login, the plugin finds the token.
- Fix round 2: banner no longer doubles "GitHub: GitHub 502" (format.ts errorLine); with an error and no last good poll the columns say "Unavailable until GitHub answers." instead of the empty states (emptyLine).
- Fix round 3: the combined query (8–11 s) hit GitHub's ~10 s cut (502 / 200 without data). Measured: the search alone is 4–5 s even for ids; page size does not matter. Now 3 parallel id searches + nodes(ids:) details per list, each request 3.0–5.3 s; graphql() retries once on 502/503/504 or no data. 6/6 refreshes ok on the side stack (~7–8 s end to end).

## Gotchas
- `tsc -p server/tsconfig.json` without `--noEmit` writes .js next to every .ts (the spec's
  verify command) → `noEmit: true` set in server/tsconfig.json.
- A fresh Barista worktree needs root + shared `bun install` before the plugin typechecks.
- Fix round 3b (epic lead's tightened spec): collect.ts runs review/direct/mine searches in
  parallel (ids only) + nodes(ids:) details per list; graphql() retries once after 1 s on
  502/503/504, no data, our 20 s timeout or a network error; a list that still fails keeps its
  last good rows + its own error (snapshot.ts mergeSnapshot, Snapshot.parts); a list never loaded
  since boot re-polls after 30 s (nextDelayMs). Measured: search 2.9–4.9 s, details(35) 2.9–4.5 s;
  a full-field search is 6.9–8.0 s at first:50 AND first:30 → kept first:50 + two-phase.
  10/10 live refreshes ok (6.7–10.4 s end to end).
- Open, GitHub-side: `author:@me org:LLjo org:StayLive` search often returns PARTIAL results
  (REST shows incomplete_results=true: 35 total, 27 items; or total 23). Not caused by parallel
  requests (same rate sequential). Mine count varied 18–35 across the 10 refreshes.
  Hammering it also trips GitHub's secondary rate limit (403).
- Round 3c (never silently drop PRs): GraphQL search has no incompleteResults field, so the
  three id searches moved to REST /search/issues (incomplete_results, or items < min(total,50)).
  A partial list is unioned with the last good rows (snapshot.ts unionPartial; "you" kept) and
  the column says "GitHub returned partial results; N kept from the last sync." Rate-limit
  403/429 → one short line. Live: 2 refreshes ok at 2.9–3.2 s total, then GitHub's secondary
  rate limit (account-wide, after this session's debugging) → last good kept, per-list error.
- Round 3d (tester retest): a 403/429 rate limit (secondary-limit text, Retry-After, or
  x-ratelimit-remaining 0) is a RateLimitError with retryAt (Retry-After, else reset, else 3 min),
  never retried; the poller makes NO GitHub calls until it lifts (↻, settings save and timer
  included) and schedules the next poll after it; the column counts down "GitHub rate limit,
  retrying in N min". Orphan pid 27145 (cwd = this worktree's plugins/pr-radar) still alive:
  kill-guard denies it from this session. Instance 1 not restarted after 0a489d5 by request.
