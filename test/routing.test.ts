import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { budgetCap, describeRouting, routingPayload } from "../src/routing.ts";
import type { ModelRouting } from "../src/types.ts";

const ordered: ModelRouting = {
	mode: "order",
	providers: ["deepseek", "deepinfra"],
	caps: { deepseek: 393_216, deepinfra: 131_072 },
};

describe("routingPayload", () => {
	it("maps each mode onto its OpenRouter field", () => {
		assert.deepEqual(routingPayload(ordered), { order: ["deepseek", "deepinfra"] });
		assert.deepEqual(routingPayload({ mode: "only", providers: ["deepinfra"] }), { only: ["deepinfra"] });
		assert.deepEqual(routingPayload({ mode: "ignore", providers: ["morph"] }), { ignore: ["morph"] });
		assert.equal(routingPayload(undefined), undefined);
		assert.equal(routingPayload({ mode: "order", providers: [] }), undefined);
	});
});

describe("budgetCap", () => {
	it("clamps to the tightest provider so every listed provider stays eligible", () => {
		// DeepSeek rejects >393,216 and DeepInfra >131,072, so Pi's 943,718 budget drops both and
		// OpenRouter falls back to Morph (verified against the live API).
		assert.equal(budgetCap(ordered, 943_718), 131_072);
		// Order does not change the clamp: the head keeps priority among eligible providers, and
		// the tail stays usable as a fallback.
		assert.equal(budgetCap({ ...ordered, providers: ["deepinfra", "deepseek"] }, 943_718), 131_072);
	});

	it("clamps an only-pool to its tightest member so no pool member is dropped", () => {
		assert.equal(budgetCap({ ...ordered, mode: "only" }, 943_718), 131_072);
	});

	it("leaves budgets the tightest provider can honor alone", () => {
		// 393,216 is fine for DeepSeek but still excludes DeepInfra, so it gets clamped too.
		assert.equal(budgetCap(ordered, 393_216), 131_072);
		assert.equal(budgetCap(ordered, 131_072), undefined);
		assert.equal(budgetCap(ordered, 128_000), undefined);
	});

	it("never clamps without caps or without a request budget", () => {
		assert.equal(budgetCap({ mode: "order", providers: ["deepseek"] }, 943_718), undefined);
		assert.equal(budgetCap({ ...ordered, caps: {} }, 943_718), undefined);
		assert.equal(budgetCap(ordered, undefined), undefined);
	});

	it("ignores caps of providers that are not configured", () => {
		assert.equal(budgetCap({ ...ordered, providers: ["deepinfra"] }, 943_718), 131_072);
		assert.equal(budgetCap({ ...ordered, providers: ["unknown", "deepseek"] }, 943_718), 393_216);
		// An unknown provider cannot tighten the clamp, so it also cannot exclude the others.
		assert.equal(budgetCap({ ...ordered, providers: ["unknown", "deepseek"] }, 393_216), undefined);
	});
});

describe("budgetCap for ignore", () => {
	const pool: ModelRouting = {
		mode: "ignore",
		providers: ["morph"],
		caps: { morph: 943_718, deepseek: 393_216, deepinfra: 131_072 },
	};

	it("clamps to the tightest surviving provider", () => {
		assert.equal(budgetCap(pool, 943_718), 131_072);
	});

	it("ignores outliers below an eighth of the pool's best budget", () => {
		// 943,718 / 8 = 117,965, so a 4,096 endpoint is left to be filtered out instead of
		// shrinking every response in the pool to 4,096 tokens.
		const withOutlier = { ...pool, caps: { ...pool.caps, venice: 4_096 } };
		assert.equal(budgetCap(withOutlier, 943_718), 131_072);
	});

	it("matches ignored providers by base slug", () => {
		const variant: ModelRouting = {
			mode: "ignore",
			providers: ["deepinfra/fp8/priority"],
			caps: { deepinfra: 131_072, deepseek: 393_216 },
		};
		assert.equal(budgetCap(variant, 943_718), 393_216);
	});

	it("leaves the budget alone when every provider is ignored", () => {
		const all = { ...pool, providers: ["morph", "deepseek", "deepinfra"] };
		assert.equal(budgetCap(all, 943_718), undefined);
	});
});

describe("describeRouting", () => {
	it("shows the mode, providers and effective output cap", () => {
		assert.equal(describeRouting(ordered), "ordered: deepseek, deepinfra (max 131,072 out)");
		assert.equal(describeRouting({ ...ordered, mode: "only" }), "only: deepseek, deepinfra (max 131,072 out)");
		assert.equal(describeRouting({ mode: "ignore", providers: ["morph"] }), "ignore: morph");
		assert.equal(describeRouting(undefined), "default routing");
	});
});
