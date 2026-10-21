<script lang="ts" generics="F extends string">
	import PrRowView from "./PrRow.svelte";
	import { groupByRepo, splitRepo } from "./format.js";
	import type { PrRow } from "./types.js";

	let {
		title, mode, rows, count, total, accent = false, segments, filter = $bindable(), empty, error, now,
	}: {
		title: string;
		mode: "review" | "mine";
		/** Already filtered. */
		rows: PrRow[];
		/** The badge number (unfiltered list length). */
		count: number;
		/** GitHub's issueCount, shown when it exceeds the 50 fetched. */
		total: number;
		accent?: boolean;
		segments: { value: F; label: string }[];
		filter: F;
		empty: string;
		/** This list's own fetch error; its last good rows (if any) still show below it. */
		error?: string;
		now: number;
	} = $props();

	const groups = $derived(groupByRepo(rows));
</script>

<section class="col">
	<h2>
		{title}
		<span class="n" class:me={accent}>{count}</span>
		{#if total > count}<span class="more" title="GitHub has {total}; the first {count} are shown">of {total}</span>{/if}
		<span class="seg" role="group">
			{#each segments as s (s.value)}
				<button type="button" class:on={filter === s.value} aria-pressed={filter === s.value} onclick={() => (filter = s.value)}>{s.label}</button>
			{/each}
		</span>
	</h2>

	{#if error}<p class="err">{error}</p>{/if}

	{#each groups as g (g.repo)}
		{@const [owner, name] = splitRepo(g.repo)}
		<div class="grp">
			<h3>{owner}<b>{name}</b></h3>
			{#each g.rows as pr (pr.id)}
				<PrRowView {pr} {mode} {now} />
			{/each}
		</div>
	{:else}
		<p class="empty">{empty}</p>
	{/each}
</section>

<style>
	.col { min-width: 0; }
	h2 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; font: 600 var(--t-m) var(--sans); color: var(--ink-2); }
	.n { min-width: 18px; padding: 0 6px; border-radius: var(--r-pill); background: var(--raised); font: 500 var(--t-xs)/18px var(--mono); text-align: center; color: var(--ink-2); }
	.n.me { background: var(--accent); color: var(--on-accent); }
	.more { font: 400 var(--t-xs) var(--mono); color: var(--ink-3); }
	.seg { margin-left: auto; display: inline-flex; gap: 2px; font-weight: 400; font-size: var(--t-xs); }
	.seg button { padding: 1px 8px; border: 0; border-radius: var(--r-pill); background: none; color: var(--ink-3); cursor: pointer; }
	.seg button.on { background: var(--sel); color: var(--ink); }
	.grp { margin-top: 10px; }
	.grp:first-of-type { margin-top: 2px; }
	.grp h3 { margin: 0 0 2px; padding: 0 10px; font: 500 var(--t-xs) var(--mono); color: var(--ink-3); }
	.grp h3 b { color: var(--ink-2); font-weight: 500; }
	.grp :global(.pr + .pr) { border-top: 1px solid var(--line); border-radius: 0; }
	.err { margin: 2px 0 6px; padding: 3px 10px; border-radius: var(--r-sm); background: var(--fail-bg); color: var(--fail-fg); font-size: var(--t-s); }
	.empty { margin: 8px 10px; font-size: var(--t-s); color: var(--ink-3); }
</style>
