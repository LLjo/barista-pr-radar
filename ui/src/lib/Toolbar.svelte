<script lang="ts">
	import { tick } from "svelte";
	import { syncLine } from "./format.js";
	import type { RefreshSec, Settings, Snapshot } from "./types.js";

	let {
		settings, count, snapshot, now, refreshing, onsave, onrefresh,
	}: {
		settings: Settings;
		count: number;
		snapshot: Snapshot | null;
		now: number;
		refreshing: boolean;
		onsave: (s: Settings) => void;
		onrefresh: () => void;
	} = $props();

	let adding = $state(false);
	let orgDraft = $state("");
	let orgInput: HTMLInputElement | undefined = $state();
	// The repo field is edited locally and saved on blur / Enter; re-seeded when the saved list changes.
	let repoText = $state("");
	$effect(() => { repoText = settings.repos.join(", "); });

	const EVERY: { value: RefreshSec; label: string }[] = [
		{ value: 60, label: "1 min" },
		{ value: 300, label: "5 min" },
		{ value: 900, label: "15 min" },
	];

	async function startAdd() {
		adding = true;
		orgDraft = "";
		await tick();
		orgInput?.focus();
	}

	function commitOrg() {
		const org = orgDraft.trim();
		adding = false;
		if (org && !settings.orgs.some((o) => o.toLowerCase() === org.toLowerCase())) onsave({ ...settings, orgs: [...settings.orgs, org] });
	}

	function orgKey(e: KeyboardEvent) {
		if (e.key === "Enter") commitOrg();
		else if (e.key === "Escape") adding = false;
	}

	function removeOrg(org: string) {
		onsave({ ...settings, orgs: settings.orgs.filter((o) => o !== org) });
	}

	function commitRepos() {
		const repos = repoText.split(",").map((r) => r.trim()).filter(Boolean);
		if (repos.join(",") !== settings.repos.join(",")) onsave({ ...settings, repos });
	}

	function setEvery(e: Event) {
		onsave({ ...settings, refreshSec: Number((e.currentTarget as HTMLSelectElement).value) as RefreshSec });
	}
</script>

<div class="bar">
	<h1>PR Radar</h1>
	<span class="field">Orgs
		{#each settings.orgs as org (org)}
			<span class="org">{org}<button type="button" title="Remove {org}" aria-label="Remove {org}" onclick={() => removeOrg(org)}>×</button></span>
		{/each}
		{#if adding}
			<input class="org-in" bind:this={orgInput} bind:value={orgDraft} placeholder="org" onkeydown={orgKey} onblur={() => (adding = false)} />
		{:else}
			<button type="button" class="add" onclick={startAdd}>+ add</button>
		{/if}
	</span>
	<label>Repos <input bind:value={repoText} placeholder="all repos" onblur={commitRepos} onkeydown={(e) => e.key === "Enter" && commitRepos()} /></label>
	<label>Every
		<select value={settings.refreshSec} onchange={setEvery}>
			{#each EVERY as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
		</select>
	</label>
	<span class="sync">
		<span class="chip wait">{count} to review</span>
		{syncLine(snapshot, now)}
		<button type="button" title="Refresh" aria-label="Refresh" class:spin={refreshing} disabled={refreshing} onclick={onrefresh}>↻</button>
	</span>
</div>

<style>
	.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); font-size: var(--t-s); color: var(--ink-2); }
	h1 { margin: 0 6px 0 0; font: 600 var(--t-l) var(--display); color: var(--ink); }
	label, .field { display: inline-flex; align-items: center; gap: 6px; }
	.org { padding: 1px 8px; border-radius: var(--r-pill); background: var(--sel); color: var(--ink); }
	.org button { margin-left: 2px; padding: 0; border: 0; background: none; color: var(--ink-3); cursor: pointer; }
	.org button:hover { color: var(--ink); }
	input { width: 150px; }
	.org-in { width: 110px; }
	.add { padding: 0; border: 0; background: none; color: var(--ink-3); cursor: pointer; }
	.add:hover { color: var(--ink); }
	.sync { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--ink-3); }
	.sync button { background: none; border: 0; color: var(--ink-2); cursor: pointer; }
	.sync button:disabled { cursor: default; opacity: .6; }
	.spin { animation: spin 1s linear infinite; }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
