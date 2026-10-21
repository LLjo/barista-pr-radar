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

## Gotchas
- `tsc -p server/tsconfig.json` without `--noEmit` writes .js next to every .ts (the spec's
  verify command) → `noEmit: true` set in server/tsconfig.json.
- A fresh Barista worktree needs root + shared `bun install` before the plugin typechecks.
