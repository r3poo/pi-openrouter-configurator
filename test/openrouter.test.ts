import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeOverrides,
	desiredFromUpstream,
	perMillion,
	toModelsJsonDefinition,
	type UpstreamModel,
} from "../src/openrouter.ts";
import type { CatalogModel } from "../src/types.ts";

const upstream: UpstreamModel = {
	id: "anthropic/claude-sonnet-4.6",
	name: "Anthropic: Claude Sonnet 4.6",
	context_length: 1_000_000,
	architecture: { input_modalities: ["text", "image", "file"], output_modalities: ["text"] },
	pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
	top_provider: { context_length: 1_000_000, max_completion_tokens: 64_000 },
	supported_parameters: ["reasoning", "tools"],
};

const catalogModel: CatalogModel = {
	id: "anthropic/claude-sonnet-4.6",
	name: "Anthropic: Claude Sonnet 4.6",
	input: ["text", "image"],
	reasoning: true,
	contextWindow: 200_000,
	maxTokens: 32_000,
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
};

describe("perMillion", () => {
	it("converts per-token strings to per-million numbers", () => {
		assert.equal(perMillion("0.000003"), 3);
		assert.equal(perMillion("0.0000003"), 0.3);
		assert.equal(perMillion(undefined), undefined);
		assert.equal(perMillion("free"), undefined);
	});
});

describe("desiredFromUpstream", () => {
	it("maps the catalog shape onto Pi model metadata", () => {
		const desired = desiredFromUpstream(upstream);
		assert.deepEqual(desired, {
			id: "anthropic/claude-sonnet-4.6",
			name: "Anthropic: Claude Sonnet 4.6",
			input: ["text", "image"],
			reasoning: true,
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			cost: { input: 3, output: 15, cacheRead: 0.3 },
		});
	});

	it("skips models that are not text generators or have no price", () => {
		assert.equal(desiredFromUpstream({ ...upstream, architecture: { output_modalities: ["image"] } }), undefined);
		assert.equal(desiredFromUpstream({ ...upstream, pricing: {} }), undefined);
	});
});

describe("toModelsJsonDefinition", () => {
	it("produces a complete models.json entry", () => {
		const desired = desiredFromUpstream(upstream)!;
		assert.deepEqual(toModelsJsonDefinition(desired, "openai-completions", "https://openrouter.ai/api/v1"), {
			id: "anthropic/claude-sonnet-4.6",
			name: "Anthropic: Claude Sonnet 4.6",
			api: "openai-completions",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		});
	});
});

describe("computeOverrides", () => {
	it("returns undefined when the built-in catalog already matches", () => {
		const current: CatalogModel = {
			...catalogModel,
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
		};
		assert.equal(computeOverrides(desiredFromUpstream(upstream)!, current), undefined);
	});

	it("raises stale limits and refreshes prices without lowering local values", () => {
		const desired = desiredFromUpstream(upstream)!;
		assert.deepEqual(computeOverrides(desired, catalogModel), {
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		});

		const textOnly: CatalogModel = { ...catalogModel, input: ["text"], cost: { input: 2, output: 15 } };
		assert.deepEqual(computeOverrides(desired, textOnly), {
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
		});

		// Local limits may be personalized upward; never lower them from the public catalog.
		const higher: CatalogModel = { ...catalogModel, contextWindow: 2_000_000, maxTokens: 128_000 };
		assert.equal(computeOverrides(desired, higher), undefined);
	});

	it("keeps rewriting fields this plugin already manages", () => {
		const desired = desiredFromUpstream(upstream)!;
		const current: CatalogModel = { ...catalogModel, name: desired.name, cost: desired.cost };
		const overrides = computeOverrides(desired, current, { name: desired.name });
		assert.deepEqual(overrides, { name: desired.name, contextWindow: 1_000_000, maxTokens: 64_000 });
	});
});
