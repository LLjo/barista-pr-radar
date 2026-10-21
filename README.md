# barista-pr-radar

A [Barista](https://github.com/LLjo/Barista) plugin: the open PRs where **you or one of your
teams** is requested as reviewer, and **your own open PRs** with review state, CI and merge
conflict. Every row links to the PR, its files and its checks.

## Install

In Barista: Plugins → **Install from repo** → `LLjo/barista-pr-radar`, then enable it.
A "PR Radar" page appears in the ⚙ menu and Ctrl K.

It needs a GitHub login on the **Barista host**: `gh auth login` (or `GITHUB_TOKEN` / `GH_TOKEN`
in Barista's environment). There is no token field in the UI; without a login the page shows a
one-line banner.

## Use

The toolbar holds every setting, saved as you change it:

- **Orgs**: limit both lists to these orgs (none = all of GitHub).
- **Repos**: comma list of `name` (expanded for every org) or `owner/name`.
- **Every**: how often the server polls GitHub (1, 5 or 15 min). ↻ polls now.

Each poll runs three searches in parallel (ids only), then one detail lookup per list: GitHub cuts any GraphQL request at about 10 s, and one combined query took 8–11 s. A 502/503/504 or a response without data is retried once. `GET /api/pr-radar/count` returns the
review-request count.

## Develop

Clone into a Barista checkout as `plugins/pr-radar` (and add it to `.git/info/exclude`):

```bash
bun install && bun test && bunx tsc -p server/tsconfig.json
cd ui && bun install && bun run build
```

`design/` holds the spec and the approved mockup (`design/mockup-final.html`).
