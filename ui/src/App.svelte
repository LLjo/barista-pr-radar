<script lang="ts">
	import { natsClient } from "@barista/plugin-sdk/ui/nats";
	import { subjects } from "../../server/subjects.js";
	import * as api from "./lib/api.js";
	import Column from "./lib/Column.svelte";
	import Toolbar from "./lib/Toolbar.svelte";
	import { emptyLine, errorLine, FILTERS_KEY, partialNote, rateLimitLine, filterMine, filterReview, parseFilters, type MineFilter, type ReviewFilter } from "./lib/format.js";
	import type { PartState, Settings, Snapshot } from "./lib/types.js";

	let snapshot = $state<Snapshot | null>(null);
	let settings = $state<Settings>({ orgs: [], repos: [], refreshSec: 300 });
	let loadError = $state<string | null>(null);
	let saveError = $state<string | null>(null);
	let refreshing = $state(false);
	let now = $state(Date.now());

	const initial = parseFilters(localStorage.getItem(FILTERS_KEY));
	let reviewFilter = $state<ReviewFilter>(initial.review);
	let mineFilter = $state<MineFilter>(initial.mine);
	$effect(() => { localStorage.setItem(FILTERS_KEY, JSON.stringify({ review: reviewFilter, mine: mineFilter })); });

	const reviewRows = $derived(filterReview(snapshot?.reviewRequested ?? [], reviewFilter));
	const mineRows = $derived(filterMine(snapshot?.mine ?? [], mineFilter));
	const count = $derived(snapshot?.reviewRequested.length ?? 0);
	// Loading = no poll has finished yet: nothing fetched and nothing failed.
	const loading = $derived(
		!snapshot || (!snapshot.fetchedAt && !snapshot.error && !snapshot.parts.reviewRequested.error && !snapshot.parts.mine.error),
	);
	// Each list fails alone and keeps its own last good fetch (server/snapshot.ts).
	const reviewPart = $derived(snapshot?.parts.reviewRequested ?? { fetchedAt: null });
	const minePart = $derived(snapshot?.parts.mine ?? { fetchedAt: null });
	const stateOf = (p: PartState) => ({ loading, error: !!p.error, hasData: !!p.fetchedAt });
	/** A list's own error line; "auth" is the page-wide banner instead. */
	const partError = (p: PartState) =>
		p.retryAt ? rateLimitLine(p.retryAt, now) : p.error && p.error !== "auth" ? errorLine(p.error) : undefined;

	async function load() {
		try {
			snapshot = await api.getSnapshot();
			loadError = null;
		} catch (e) {
			loadError = (e as Error).message;
		}
	}

	async function refresh() {
		refreshing = true;
		try {
			snapshot = await api.refresh();
			loadError = null;
		} catch (e) {
			loadError = (e as Error).message;
		} finally {
			refreshing = false;
		}
	}

	async function save(next: Settings) {
		const before = settings;
		settings = next;
		try {
			settings = await api.saveSettings(next);
			saveError = null;
		} catch (e) {
			settings = before;
			saveError = (e as Error).message;
		}
	}

	$effect(() => {
		api.getSettings().then((s) => (settings = s), (e) => (loadError = (e as Error).message));
		load();
		const sub = natsClient.subscribe(subjects.changed, () => load());
		const clock = setInterval(() => (now = Date.now()), 30_000);
		return () => { sub.unsubscribe(); clearInterval(clock); };
	});

	// Fallback for a missed NATS event: re-read at the refresh interval.
	$effect(() => {
		const t = setInterval(load, settings.refreshSec * 1000);
		return () => clearInterval(t);
	});
</script>

<div class="page">
	<Toolbar {settings} {count} fetchedAt={snapshot?.fetchedAt ?? null} {now} {refreshing} onsave={save} onrefresh={refresh} />

	{#if snapshot?.error === "auth"}
		<p class="banner">GitHub is not signed in on the Barista host. Run <code>gh auth login</code>.</p>
	{/if}
	{#if loadError}<p class="banner">PR Radar: {loadError}</p>{/if}
	{#if saveError}<p class="banner">Settings not saved: {saveError}</p>{/if}
	{#if snapshot?.warning}<p class="note">{snapshot.warning}</p>{/if}
	{#if !settings.orgs.length && !settings.repos.length}<p class="note">All orgs. Add one in settings to narrow it.</p>{/if}

	<div class="cols">
		<Column
			title="To review" mode="review" accent {now}
			rows={reviewRows} {count} total={snapshot?.totals.reviewRequested ?? 0}
			segments={[{ value: "all", label: "All" }, { value: "me", label: "Me" }, { value: "teams", label: "Teams" }]}
			bind:filter={reviewFilter}
			error={partError(reviewPart)} note={partialNote(reviewPart)}
			empty={emptyLine("review", { ...stateOf(reviewPart), filter: reviewFilter })}
		/>
		<Column
			title="Mine" mode="mine" {now}
			rows={mineRows} count={snapshot?.mine.length ?? 0} total={snapshot?.totals.mine ?? 0}
			segments={[{ value: "open", label: "Open" }, { value: "drafts", label: "Drafts" }]}
			bind:filter={mineFilter}
			error={partError(minePart)} note={partialNote(minePart)}
			empty={emptyLine("mine", { ...stateOf(minePart), filter: mineFilter })}
		/>
	</div>
</div>

<style>
	.page { padding: 14px 18px 30px; }
	.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 14px; }
	@media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }
	.banner { margin: 10px 0 0; padding: 4px 10px; border-radius: var(--r-sm); background: var(--fail-bg); color: var(--fail-fg); font-size: var(--t-s); }
	.banner code { font-family: var(--mono); }
	.note { margin: 8px 0 0; font-size: var(--t-s); color: var(--ink-3); }
</style>
