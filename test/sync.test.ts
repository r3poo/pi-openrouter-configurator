import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { emptyConfig, loadConfig, saveConfig } from "../src/config.ts";
import { readModelsJson, writeModelsJson } from "../src/models-json.ts";
import type { UpstreamModel } from "../src/openrouter.ts";
import { isSyncDue, runSync, SYNC_INTERVAL_MS, type SyncRegistry } from "../src/sync.ts";
import type { CatalogModel } from "../src/types.ts";

const dirs: string[] = [];
function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "openrouter-sync-"));
	dirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const knownUpstream: UpstreamModel = {
	id: "known/model",
	name: "Known Model",
	context_length: 400_000,
	architecture: { input_modalities: ["text"], output_modalities: ["text"] },
	pricing: { prompt: "0.0000005", completion: "0.0000015" },
	top_provider: { max_completion_tokens: 20_000 },
	supported_parameters: [],
};

const newUpstream: UpstreamModel = {
	...knownUpstream,
	id: "brand/new-model",
	name: "Brand New Model",
};

const staleUpstream: UpstreamModel = { ...knownUpstream, id: "gone/model", name: "Gone" };

const knownCatalogModel: CatalogModel = {
	id: "known/model",
	provider: "openrouter",
	name: "Known Model",
	input: ["text"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 8_192,
	cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
};

function fakeRegistry(models: CatalogModel[]): SyncRegistry & { refreshCount: number } {
	let refreshCount = 0;
	return {
		getAll: () => models,
		refresh: () => {
			refreshCount += 1;
		},
		get refreshCount() {
			return refreshCount;
		},
	};
}

describe("isSyncDue", () => {
	it("is due without a timestamp and after 24 hours", () => {
		const now = Date.parse("2026-02-02T00:00:00.000Z");
		assert.equal(isSyncDue(emptyConfig(), now), true);
		assert.equal(isSyncDue({ ...emptyConfig(), sync: { lastRunAt: new Date(now - 1000).toISOString(), added: [], overrides: [] } }, now), false);
		assert.equal(
			isSyncDue({ ...emptyConfig(), sync: { lastRunAt: new Date(now - SYNC_INTERVAL_MS).toISOString(), added: [], overrides: [] } }, now),
			true,
		);
	});
});

describe("runSync", () => {
	it("adds unknown models and overrides stale metadata", async () => {
		const agentDir = tempAgentDir();
		const registry = fakeRegistry([knownCatalogModel]);
		const result = await runSync({
			agentDir,
			registry,
			fetchModels: async () => [knownUpstream, newUpstream],
			now: Date.parse("2026-02-02T00:00:00.000Z"),
		});

		assert.equal(result.ok, true);
		assert.deepEqual(result.added, ["brand/new-model"]);
		assert.deepEqual(result.overrides, ["known/model"]);
		assert.equal(registry.refreshCount, 1);

		const models = readModelsJson(agentDir).providers?.openrouter;
		assert.equal(models?.models?.length, 1);
		assert.equal(models?.models?.[0]?.id, "brand/new-model");
		assert.equal(models?.models?.[0]?.api, "openai-completions");
		assert.deepEqual(models?.modelOverrides?.["known/model"], {
			contextWindow: 400_000,
			maxTokens: 20_000,
		});

		const config = loadConfig(agentDir);
		assert.equal(config.sync.lastRunAt, "2026-02-02T00:00:00.000Z");
		assert.deepEqual(config.sync.added, ["brand/new-model"]);
		assert.deepEqual(config.sync.overrides, ["known/model"]);
	});

	it("prunes entries this plugin wrote when upstream drops them, leaving user entries alone", async () => {
		const agentDir = tempAgentDir();
		const config = emptyConfig();
		config.sync = { lastRunAt: "2026-01-01T00:00:00.000Z", added: ["gone/model"], overrides: ["gone/model"] };
		config.routing["known/model"] = { mode: "only", providers: ["anthropic"] };
		saveConfig(agentDir, config);

		writeModelsJson(agentDir, {
			providers: {
				openrouter: {
					models: [
						{ id: "gone/model", name: "Gone", api: "openai-completions" },
						{ id: "user/hand-written", name: "Mine", api: "openai-completions" },
					],
					modelOverrides: { "gone/model": { name: "Gone" }, "user/other": { name: "Keep me" } },
				},
			},
		});

		const result = await runSync({
			agentDir,
			registry: fakeRegistry([knownCatalogModel]),
			fetchModels: async () => [knownUpstream],
		});

		assert.deepEqual(result.removed.sort(), ["gone/model"]);
		const models = readModelsJson(agentDir).providers?.openrouter;
		assert.deepEqual(models?.models?.map((model) => model.id), ["user/hand-written"]);
		assert.deepEqual(Object.keys(models?.modelOverrides ?? {}).sort(), ["known/model", "user/other"]);

		const reloaded = loadConfig(agentDir);
		assert.deepEqual(reloaded.routing, { "known/model": { mode: "only", providers: ["anthropic"] } });
		assert.deepEqual(reloaded.sync.added, []);
	});

	it("leaves hand-written overrides alone, even when they already match upstream", async () => {
		const agentDir = tempAgentDir();
		writeModelsJson(agentDir, {
			providers: { openrouter: { models: [], modelOverrides: { "known/model": { name: "My Label" } } } },
		});

		const matching: CatalogModel = {
			...knownCatalogModel,
			contextWindow: 400_000,
			maxTokens: 20_000,
			cost: { input: 0.5, output: 1.5 },
		};
		const result = await runSync({
			agentDir,
			registry: fakeRegistry([matching]),
			fetchModels: async () => [knownUpstream],
		});

		assert.deepEqual(readModelsJson(agentDir).providers?.openrouter?.modelOverrides, { "known/model": { name: "My Label" } });
		assert.deepEqual(result.overrides, []);
	});

	it("does not touch the catalog when the fetch fails", async () => {
		const agentDir = tempAgentDir();
		writeModelsJson(agentDir, { providers: { openrouter: { models: [{ id: "keep/me", api: "openai-completions" }] } } });
		writeFileSync(join(agentDir, "openrouter-configurator.json"), JSON.stringify(emptyConfig()));

		const result = await runSync({
			agentDir,
			registry: fakeRegistry([]),
			fetchModels: async () => {
				throw new Error("network down");
			},
		});

		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /network down/);
		assert.equal(readModelsJson(agentDir).providers?.openrouter?.models?.[0]?.id, "keep/me");
		assert.equal(loadConfig(agentDir).sync.lastRunAt, undefined);
	});
});
