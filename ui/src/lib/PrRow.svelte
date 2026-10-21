<script lang="ts">
	import { age, ciLabel, statusChips } from "./format.js";
	import type { PrRow } from "./types.js";

	let { pr, mode, now }: { pr: PrRow; mode: "review" | "mine"; now: number } = $props();

	const chips = $derived(mode === "mine" ? statusChips(pr) : []);
	const ci = $derived(mode === "mine" ? ciLabel(pr) : null);
</script>

{#snippet links()}
	<span class="links">
		<a href={pr.links.pr} target="_blank" rel="noopener">PR</a>
		<a href={pr.links.files} target="_blank" rel="noopener">Files</a>
		<a href={pr.links.checks} target="_blank" rel="noopener">Checks</a>
	</span>
{/snippet}

<div class="pr">
	<a class="title" href={pr.links.pr} target="_blank" rel="noopener" title={pr.title}>{pr.title}</a>
	{#if mode === "review"}
		<div class="line2">
			<span class="num">#{pr.number}</span>
			<span>{pr.author} · {age(pr.createdAt, now)}</span>
			{#if pr.via?.kind === "you"}<span class="via">you</span>
			{:else if pr.via}<span>{pr.via.team}</span>{/if}
		</div>
		<div class="side">{@render links()}</div>
	{:else}
		<div class="line2">
			<span class="num">#{pr.number}</span>
			<span>{age(pr.updatedAt, now)}</span>
			{@render links()}
		</div>
		<div class="side">
			{#if chips.length}
				<span class="st">{#each chips as c (c.label)}<span class="chip {c.kind}" title={c.title}>{c.label}</span>{/each}</span>
			{/if}
			{#if ci}<span class="ci {ci.kind}">{ci.label}</span>{/if}
		</div>
	{/if}
</div>

<style>
	.pr { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 8px 10px; border-radius: var(--r-sm); }
	.pr:hover { background: var(--hover); }
	.title { min-width: 0; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.line2 { grid-column: 1; display: flex; gap: 8px; align-items: center; min-width: 0; font-size: var(--t-xs); color: var(--ink-3); }
	.num { font-family: var(--mono); }
	.side { grid-row: 1 / span 2; grid-column: 2; display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 4px; }
	.st { display: flex; gap: 6px; align-items: center; }
	.via { color: var(--accent); }
</style>
