import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pricePrecision, specRow, specWidths } from "../src/menu.ts";
import type { ProviderOption } from "../src/openrouter.ts";

const PROVIDERS: ProviderOption[] = [
	{ slug: "deepinfra", name: "DeepInfra", uptime: 99.94, promptPricePerMillion: 0.15, maxCompletionTokens: 65_536 },
	{ slug: "deepinfra/fp8/priority", name: "DeepInfra", uptime: 98, promptPricePerMillion: 3.5, maxCompletionTokens: 131_072 },
	{ slug: "morph", name: "Morph", uptime: 100, promptPricePerMillion: 0.27 },
];

/** Where a cell's unit starts, i.e. the column it was padded into. */
function unitColumn(row: string, unit: string): number {
	return row.indexOf(unit);
}

describe("provider spec rows", () => {
	const widths = specWidths(PROVIDERS);
	const rows = PROVIDERS.map((provider) => specRow(provider, widths));

	it("stacks the columns from row to row", () => {
		// Cells are right-aligned, so it is the right edge that must coincide.
		const edge = (row: string, unit: string) => row.indexOf(unit) + unit.length;
		for (const unit of ["% up", "/M in"]) {
			const columns = new Set(rows.map((row) => edge(row, unit)));
			assert.equal(columns.size, 1, `${unit} should end in one column, saw ${[...columns].join(", ")}`);
		}
		const maxEdges = new Set(rows.filter((row) => row.includes("max ")).map((row) => edge(row, "out")));
		assert.equal(maxEdges.size, 1);
	});

	it("right-aligns each numeric cell, units included", () => {
		const [deepinfra, priority, morph] = rows as [string, string, string];
		assert.equal(deepinfra, "deepinfra                99.9% up  $0.15/M in   max 65.5K out");
		assert.equal(priority, "deepinfra/fp8/priority   98.0% up  $3.50/M in  max 131.1K out");
		// No `max … out` reported: the gap stays behind the other cells keep their columns.
		assert.equal(morph, "morph                   100.0% up  $0.27/M in");
	});

	it("shows missing specs as blanks rather than shifting the row", () => {
		const bare = specRow({ slug: "x", name: "X" }, specWidths([...PROVIDERS, { slug: "x", name: "X" }]));
		assert.equal(bare, "x");
	});

	it("uses one price precision per list", () => {
		assert.equal(pricePrecision(PROVIDERS), 2);
		assert.equal(pricePrecision([{ slug: "cheap", name: "Cheap", promptPricePerMillion: 0.005 }]), 4);
		assert.equal(pricePrecision([{ slug: "cheaper", name: "Cheaper", promptPricePerMillion: 0.0005 }]), 5);
		assert.equal(pricePrecision([{ slug: "micro", name: "Micro", promptPricePerMillion: 0.00005 }]), 5);
		// A sub-cent model widens the shared precision, so its neighbours grow decimals too.
		const mixed = specWidths([...PROVIDERS, { slug: "cheap", name: "Cheap", promptPricePerMillion: 0.005 }]);
		assert.equal(mixed.precision, 4);
		assert.match(specRow(PROVIDERS[0]!, mixed), /\$0\.1500\/M in/);
	});

	it("marks free endpoints instead of printing $0.00", () => {
		const free = specWidths([{ slug: "free", name: "Free", promptPricePerMillion: 0 }]);
		assert.equal(specRow({ slug: "free", name: "Free", promptPricePerMillion: 0 }, free), "free  free");
	});
});
