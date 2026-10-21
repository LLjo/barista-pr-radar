# PR Radar: build spec

PR Radar is a Barista plugin. It shows (a) open PRs where **you or one of your teams** is
requested as reviewer and (b) **your own open PRs**: draft or open, review state, CI and
merge conflict. Every row links to the PR, its files and its checks. You no longer need to
open GitHub notifications to find out what is waiting on you.

It is an **external** plugin: it lives only in `LLjo/barista-pr-radar` and installs through
Barista's Plugins page, "Install from repo". **Barista's own code does not change.**

> **Chosen layout: _pending the human's pick_** (see "Layout" below). Mockups:
> `design/mockup-a.html` (compact list), `design/mockup-b.html` (two columns),
> `design/mockup-c.html` (grouped by repo); `design/index.html` shows all three.

## How to work

- Use your Barista worktree, and clone this repo into it:
  `gh repo clone LLjo/barista-pr-radar plugins/pr-radar`. Then add `plugins/pr-radar/` to the
  worktree's `.git/info/exclude`. Do **not** commit anything to the Barista repo.
- Commit on a branch in this repo and push it to `LLjo/barista-pr-radar`. If `git commit`
  says "Author identity unknown", set `user.name`/`user.email` in this repo from the outer
  Barista repo's values.
- Start from the scaffolder rather than writing the boilerplate by hand. `plugins/pr-radar`
  already exists, so the scaffolder refuses to write there. Generate into a temporary
  directory and copy the files over:
  `bun run scripts/create-plugin.ts pr-radar --dir /tmp/prr --description "PRs waiting on you and the state of yours"`.
  Then `cp -r /tmp/prr/pr-radar/. plugins/pr-radar/` and delete the scaffold's sample
  `items` code.
- Background reading, all in the Barista repo:
  - `scripts/claude-plugins/barista-dev/skills/notes/areas/plugins.md`: layout, SDK, UI conventions.
  - `scripts/claude-plugins/barista-dev/skills/notes/areas/github-auth.md`: the gh token helper.
  - `plugins/console`: the smallest real plugin with SQLite and a Svelte UI.

## Files

```
manifest.json         {"name":"pr-radar","title":"PR Radar","description":"…","icon":"pr","version":"0.1.0"}
                      no dependsOn/enhances: it calls no other plugin
package.json          scaffold deps (hono 4.12.9 exact, zod ^4.3.6, @hono/zod-validator, SDK + types via
                      file:../../shared/…); NO octokit: plain fetch to the GraphQL endpoint
bun.lock, ui/bun.lock committed (Install from repo runs `bun install` in a clean folder)
plugin.ts             definePlugin<AppType>(import.meta.dirname)
server/
  index.ts            registerRoutes, registerHealthCheck(db.health), registerShutdown(closeDb), start, startPoller()
  db.ts               openStorage({dir: PLUGIN_DATA_DIR/pr-radar, name: "pr-radar"}); one table, below
  settings.ts         getSettings()/saveSettings(): validate + read/write the settings row
  query.ts            PURE: buildSearchQueries(settings) → {review, direct, mine}; GRAPHQL text
  map.ts              PURE: GraphQL node → PrRow (review state, CI summary, conflict, via, links)
  github.ts           graphql(query, vars): fetch + token from resolveGitHubToken, 401 → invalidate + retry once
  poller.ts           in-memory Snapshot, poll(), timer at settings.refreshSec, publishes subjects.changed
  routes.ts           Hono chain + zod validators; export type AppType
  subjects.ts         definePluginSubjects(manifest, { changed: subject<void>() })
  types.ts            Settings, PrRow, Snapshot
  *.test.ts           bun:test for query.ts and map.ts (fixtures in server/fixtures/*.json)
ui/                   scaffold layout: plain Svelte 5 + Vite, base "./", theme from @barista/plugin-sdk/ui/theme.css
  src/App.svelte      state + template only
  src/lib/api.ts      getSnapshot, refresh, getSettings, saveSettings: all through unwrap()
  src/lib/format.ts   age ("2h", "3d", "1w"), short repo name, chip label/kind per PrRow
  src/lib/*.svelte    PrRow, Section, SettingsPanel (split App.svelte at ~400 lines)
README.md             what it is, install from repo, needs `gh auth login` on the Barista host
```

The UI reuses the mockup's CSS almost verbatim. The mockup's `tokens.css` values are
Barista's real tokens, so import `@barista/plugin-sdk/ui/theme.css` and **do not** copy
`tokens.css`. Barista is dark-only, so the plugin ships no light theme. The mockups' light
toggle was only a readability check. Tailwind is optional: plain scoped `<style>` in the
components, as in the mockups, is fine.

## Data: one GraphQL call per poll

Auth: `resolveGitHubToken()` from `@barista/types/github-auth`. It tries `GITHUB_TOKEN`/`GH_TOKEN`
first, then `gh auth token`, and caches the result for 30 min. Report the source from
`githubAuthSource()`. There is no token field in the UI. On HTTP 401 call
`invalidateGitHubToken()` and retry once. With no token at all, the snapshot carries
`error: "auth"` and the UI says "GitHub is not signed in on the Barista host. Run
`gh auth login`."

`POST https://api.github.com/graphql` with `Authorization: bearer <token>` and the query
below. It was verified live on 2026-10-21 and costs 4 rate-limit points.

```graphql
query($rq:String!,$direct:String!,$mine:String!){
  viewer{login}
  rateLimit{cost remaining resetAt}
  review: search(type:ISSUE, query:$rq, first:50){ issueCount nodes{...Pr} }
  direct: search(type:ISSUE, query:$direct, first:50){ nodes{... on PullRequest{id}} }
  mine: search(type:ISSUE, query:$mine, first:50){ issueCount nodes{...Pr} }
}
fragment Pr on PullRequest {
  id number title url isDraft createdAt updatedAt
  author{login}
  repository{nameWithOwner}
  reviewDecision mergeable
  reviewRequests(first:10){ totalCount nodes{ requestedReviewer{ __typename ... on User{login} ... on Team{slug organization{login}} } } }
  latestOpinionatedReviews(first:10){ nodes{ state author{login} } }
  commits(last:1){ nodes{ commit{ statusCheckRollup{ state contexts(first:0){ totalCount checkRunCountsByState{state count} statusContextCountsByState{state count} } } } } }
}
```

### Search strings (`query.ts`, pure)

Every search starts with `is:pr is:open archived:false`. Then:

- `rq`: `review-requested:@me`. This matches requests to you **and** to any team you are on.
- `direct`: `user-review-requested:@me`. Only direct requests. Use it to tell "you" from "team".
- `mine`: `author:@me`. Includes drafts.

The scope qualifiers are added to all three:

- With a **repo filter** set, add one `repo:<owner>/<name>` per entry. A bare `name` expands
  to `repo:<org>/<name>` for every configured org, and an entry `owner/name` is used as is.
  No `org:` qualifier is added in this case.
- With **no repo filter**, add one `org:<org>` per configured org. Search ORs repeated
  qualifiers.
- With **no orgs and no repos**, add no scope: the search covers all of GitHub. The UI says
  "all orgs".

Keep each query string under 256 characters, which is GitHub's search limit. Settings caps
orgs at 10 and repos at 20. If the qualifiers still overflow, drop the extra ones and set
`snapshot.warning`.

### Mapping (`map.ts`, pure): `PrRow`

```ts
interface PrRow {
  id: string; number: number; title: string; url: string;
  repo: string;                 // "owner/name"
  author: string;               // login, "ghost" when null
  createdAt: string; updatedAt: string;
  draft: boolean;
  via?: { kind: "you" } | { kind: "team"; team: string };  // review list only; team = "@org/slug"
  review: "approved" | "changes" | "pending" | "none";     // mine only
  reviewers: { requested: number; approved: number };     // "review 0/2"
  ci: { state: "ok" | "failing" | "running" | "none"; passed: number; failed: number; total: number };
  conflict: boolean;
  links: { pr: string; files: string; checks: string };    // url, url+"/files", url+"/checks"
}
```

- **via**: `you` when the PR's `id` is in `direct`. Otherwise `team`, named by the first Team in
  `reviewRequests`. If no Team is listed there, fall back to `team: "a team"`.
- **review**:
  - `reviewDecision` APPROVED gives `approved`, CHANGES_REQUESTED gives `changes`, and
    REVIEW_REQUIRED gives `pending`.
  - When the decision is `null` (no branch protection), derive it from
    `latestOpinionatedReviews`: any CHANGES_REQUESTED gives `changes`, else any APPROVED gives
    `approved`, else `pending` if `reviewRequests.totalCount > 0`, else `none`.
- **reviewers**: `requested = reviewRequests.totalCount + approved`, and
  `approved = count of APPROVED in latestOpinionatedReviews`.
- **ci**: from `statusCheckRollup`. A `null` rollup gives `none`.
  - SUCCESS gives `ok`, FAILURE or ERROR gives `failing`, and PENDING or EXPECTED gives `running`.
  - `failed` = FAILURE + TIMED_OUT + CANCELLED + STARTUP_FAILURE + ACTION_REQUIRED check runs,
    plus FAILURE + ERROR status contexts.
  - `passed` = SUCCESS + NEUTRAL + SKIPPED check runs, plus SUCCESS status contexts.
  - `total = contexts.totalCount`.
- **conflict**: `mergeable === "CONFLICTING"`. `UNKNOWN` (GitHub still computing) counts as
  not conflicting.
- Order: the review list oldest request first (the one that has waited longest), mine by
  `updatedAt` descending.

### Polling (`poller.ts`)

- The server polls; the browser does not. Poll on boot, then every `refreshSec`, and
  immediately after a settings save or `POST /refresh`. Run one poll at a time: a poll that
  comes in while another is running joins it.
- Keep the last good `Snapshot` in memory. A failed poll keeps the old lists and sets `error`.
- After every poll, `nats.publish(subjects.changed)`. The UI re-reads `/prs` on it, and also
  every `refreshSec` as a fallback.

```ts
interface Snapshot {
  viewer: string | null; fetchedAt: string | null;
  auth: "env" | "gh" | "none";
  error?: "auth" | string; warning?: string;
  reviewRequested: PrRow[]; mine: PrRow[];
  totals: { reviewRequested: number; mine: number };  // issueCount (may exceed the 50 shown)
}
```

## Settings storage

One SQLite table through `openStorage`. Close it with `registerShutdown(closeDb)`, and use
anonymous `?` params only.

```sql
CREATE TABLE IF NOT EXISTS pr_radar_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  orgs TEXT NOT NULL DEFAULT '[]',        -- JSON string[]
  repos TEXT NOT NULL DEFAULT '[]',       -- JSON string[] ("name" or "owner/name")
  refresh_sec INTEGER NOT NULL DEFAULT 300,
  updated_at TEXT NOT NULL
);
```

Validation (zod, in `routes.ts`):

- `orgs`: at most 10 entries, each matching `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`.
- `repos`: at most 20 entries, each matching `^([A-Za-z0-9-]+/)?[A-Za-z0-9._-]+$`.
- `refreshSec`: one of 60, 300 or 900.

Trim entries and drop duplicates. Settings are global, one row per Barista. They are not per
project: GitHub identity is per host.

## Routes (`/api/pr-radar/…`)

| method | path | body / returns |
|---|---|---|
| GET | `/settings` | `{orgs, repos, refreshSec}` |
| PUT | `/settings` | same shape (validated) → saved settings; triggers a poll |
| GET | `/prs` | `Snapshot` |
| POST | `/refresh` | polls now, returns `Snapshot` |
| GET | `/count` | `{count}` = `reviewRequested.length`: the number the badge shows |

## Layout

**Pending the human's pick.** This section will name the chosen mockup and any changes. The
build copies that mockup's structure, spacing and chip vocabulary. The rail in the mockups
stands in for Barista's shell; the plugin does not draw it.

Common to every layout:

- **Chips**: `✓ approved` (work colours), `± changes requested` (fail), `◷ review a/n` (need),
  and `draft` (steel outline). CI shows as `● CI p/t` when passing, `✕ CI n failing` when
  failing and `◌ CI running` while running. A conflict shows `⚠ conflict` (fail). Every chip
  carries a glyph and a word as well as its colour.
- The review list shows the request source: "you" in caramel (`--accent`), or the team name
  in faint ink.
- Each row has the quick links PR, Files and Checks, all with `target="_blank"
  rel="noopener"`. The title links to the PR.
- The header shows the last sync time ("1 min ago"), a ↻ refresh button, and the
  review-requested count in caramel.
- Empty states are one line, e.g. "Nothing waiting on you." / "No open PRs." With no orgs
  configured, a hint says "All orgs. Add one in settings to narrow it."
- The auth error is a single banner line above the lists, not a modal.

## Sidebar count: what is possible without core changes

Barista core has **no** hook for a plugin to badge its rail or pinned entry. The shell builds
those entries in `packages/web/src/lib/flow/pages.ts` and `StarStrip.svelte`. They take
`title` from the manifest and an icon from a hard-coded map (`stars.ts::ICON_OF`), and no
postMessage type or NATS subject carries a count. The epic forbids core changes, so:

- The plugin serves `GET /api/pr-radar/count`, and shows the same count in its own header.
- A real rail badge is a **separate Barista core issue**. A generic version would be a
  manifest `badge: "/count"` that the shell polls, or a `barista:badge` postMessage. PR
  Radar's `/count` route is ready for it.
- The manifest `icon` is ignored by the shell today, which shows the generic page icon. Set
  `"pr"` anyway, so a future shell can use it.

## Out of scope

- Writing to GitHub: approving, commenting, merging, re-requesting.
- Notifications other than PRs: issues, discussions, mentions.
- Any change to Barista core, including the rail badge (see above).
- Closed or merged PRs, PRs you only commented on, GitHub Enterprise hosts.
- Per-project settings, multiple GitHub accounts, a token field in the UI.
- Pagination past 50 per list. The header shows `totals` when there are more.

## Acceptance

1. Install the plugin from `LLjo/barista-pr-radar` on a Barista through `POST /api/plugins/install`
   and enable it. It starts, `/health` returns ok, and a "PR Radar" page appears in the ⚙ menu
   and Ctrl K.
2. With orgs set, "Review requested" equals github.com's
   `is:pr is:open review-requested:@me org:<org>` for those orgs, and each row says "you" or
   names the team.
3. "My PRs" equals `is:pr is:open author:@me org:<org>`. Draft, review state, CI summary and
   conflict match each PR's page on github.com.
4. PR, Files and Checks open `<url>`, `<url>/files` and `<url>/checks` in a new tab.
5. Settings persist across a plugin restart. Changing them refetches within a second, and the
   refresh interval is honoured.
6. With no GitHub auth, the page shows the one-line banner and the server does not crash.
7. `GET /api/pr-radar/count` matches the review list length.
8. The layout matches the chosen mockup: slim, with no element the mockup lacks.
9. `bun test` passes in the plugin, with tests for `query.ts` (scope qualifiers, repo
   expansion, the 256-character cap) and `map.ts` (each review, CI and conflict case, and
   you versus team). `tsc -p server/tsconfig.json` is clean, and `cd ui && bun run build`
   succeeds.
10. Barista's own git status is clean: `git status` in the Barista worktree shows nothing
    from this work.

## Verify

1. In `plugins/pr-radar`: run `bun install && bun test && bunx tsc -p server/tsconfig.json`,
   then `cd ui && bun install && bun run build`. All must be green; read the pass count.
2. Bring up a side stack from the Barista worktree with `bun run dev:side`. It discovers
   `plugins/pr-radar`; if it is not listed, run `bun run side api` and
   `POST /api/plugins/rescan`. Enable the plugin and open PR Radar in the desk preview.
3. Set org `LLjo` (plus any org with review requests) and compare both lists against
   github.com/pulls/review-requested and github.com/pulls. Click each kind of link once.
4. Check that `GET /api/pr-radar/count` matches the review list.
5. Check auth handling: restart the plugin with `GH_CONFIG_DIR=/nonexistent`, so gh has no
   login, and confirm the banner shows.
6. Install-from-repo on a fresh Barista is issue #1240's job. Do not claim it here.
