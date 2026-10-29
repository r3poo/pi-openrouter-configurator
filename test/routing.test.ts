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
	it("clamps an ordered route to its first provider so that provider survives the filter", () => {
		// DeepSeek rejects >393,216 and DeepInfra >131,072, so Pi's 943,718 budget drops both and
		// OpenRouter falls back to Morph (verified against the live API).
		assert.equal(budgetCap(ordered, 943_718), 393_216);
		// Order is honoured over tightness: a tightest-first clamp would keep DeepInfra eligible
		// while dropping the provider the user actually wants.
		assert.equal(budgetCap({ ...ordered, providers: ["deepinfra", "deepseek"] }, 943_718), 131_072);
	});

	it("clamps an only-pool to its tightest member so no pool member is dropped", () => {
		assert.equal(budgetCap({ ...ordered, mode: "only" }, 943_718), 131_072);
	});

	it("leaves budgets the providers can honor alone", () => {
		assert.equal(budgetCap(ordered, 393_216), undefined);
		assert.equal(budgetCap(ordered, 128_000), undefined);
	});

	it("never clamps without caps, without a request budget, or for ignore", () => {
		assert.equal(budgetCap({ mode: "order", providers: ["deepseek"] }, 943_718), undefined);
		assert.equal(budgetCap({ ...ordered, caps: {} }, 943_718), undefined);
		assert.equal(budgetCap(ordered, undefined), undefined);
		assert.equal(budgetCap({ ...ordered, mode: "ignore" }, 943_718), undefined);
	});

	it("ignores caps of providers that are not configured", () => {
		assert.equal(budgetCap({ ...ordered, providers: ["deepinfra"] }, 943_718), 131_072);
		assert.equal(
			budgetCap({ ...ordered, providers: ["unknown", "deepseek"] }, 943_718),
			393_216,
		);
	});
});

describe("describeRouting", () => {
	it("shows the mode, providers and effective output cap", () => {
		assert.equal(describeRouting(ordered), "ordered: deepseek, deepinfra (max 393,216 out)");
		assert.equal(describeRouting({ ...ordered, mode: "only" }), "only: deepseek, deepinfra (max 131,072 out)");
		assert.equal(describeRouting({ mode: "ignore", providers: ["morph"] }), "ignore: morph");
		assert.equal(describeRouting(undefined), "default routing");
	});
});
