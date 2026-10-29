import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	attributionHeaders,
	DEFAULT_APP,
	isDefaultAttribution,
	normalizeCategories,
	normalizeReferer,
	normalizeTitle,
	parseAttribution,
} from "../src/attribution.ts";
import { emptyConfig, parseConfig } from "../src/config.ts";

describe("normalizeReferer", () => {
	it("accepts absolute http(s) urls, trimmed", () => {
		assert.equal(normalizeReferer("  https://pi.dev  "), "https://pi.dev");
		assert.equal(normalizeReferer("http://localhost:3000/app"), "http://localhost:3000/app");
	});

	it("rejects values OpenRouter cannot key an origin from", () => {
		assert.equal(normalizeReferer("pi.dev"), undefined);
		assert.equal(normalizeReferer("ftp://pi.dev"), undefined);
		assert.equal(normalizeReferer(""), undefined);
		assert.equal(normalizeReferer(42), undefined);
	});
});

describe("normalizeTitle", () => {
	it("flattens newlines and trims", () => {
		assert.equal(normalizeTitle("Pi\r\nAgent"), "Pi Agent");
	});

	it("clamps to OpenRouter's 100 character limit", () => {
		assert.equal(normalizeTitle("x".repeat(150))?.length, 100);
	});

	it("drops empty titles", () => {
		assert.equal(normalizeTitle("   "), undefined);
	});
});

describe("normalizeCategories", () => {
	it("lowercases, dedupes, filters invalid and caps the list", () => {
		assert.deepEqual(normalizeCategories(["Coding", "coding", "not a slug", "", "cli-agent", "a", "b"]), [
			"coding",
			"cli-agent",
			"a",
			"b",
		]);
	});

	it("rejects non-arrays", () => {
		assert.equal(normalizeCategories("coding"), undefined);
	});
});

describe("parseAttribution", () => {
	it("returns defaults for a missing or malformed block", () => {
		assert.deepEqual(parseAttribution(undefined), DEFAULT_APP);
		assert.deepEqual(parseAttribution("nope"), DEFAULT_APP);
		assert.deepEqual(parseAttribution({ referer: "not-a-url" }), DEFAULT_APP);
	});

	it("merges partial overrides over the defaults", () => {
		assert.deepEqual(parseAttribution({ title: "My Pi" }), { ...DEFAULT_APP, title: "My Pi" });
	});
});

describe("attributionHeaders", () => {
	it("sends the referer and title OpenRouter needs for an app record", () => {
		assert.deepEqual(attributionHeaders(DEFAULT_APP), {
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "Pi Agent",
			"X-OpenRouter-Categories": "cli-agent",
		});
	});

	it("omits the categories header when the list is empty", () => {
		const headers = attributionHeaders({ referer: "https://example.com", title: "T", categories: [] });
		assert.equal(headers["X-OpenRouter-Categories"], undefined);
	});
});

describe("config persistence", () => {
	it("defaults the app block", () => {
		assert.deepEqual(parseConfig({}).app, DEFAULT_APP);
	});

	it("recognises the default block", () => {
		assert.equal(isDefaultAttribution(parseAttribution({})), true);
		assert.equal(isDefaultAttribution(parseAttribution({ title: "My Pi" })), false);
	});

	it("keeps a custom referer across a round trip", () => {
		const config = { ...emptyConfig(), app: { referer: "https://example.com/pi", title: "Mine", categories: [] } };
		assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(config))).app, config.app);
	});
});
