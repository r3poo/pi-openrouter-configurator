import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { configPath, emptyConfig, loadConfig, parseConfig, saveConfig, setRouting } from "../src/config.ts";
import { routingPayload } from "../src/routing.ts";

const dirs: string[] = [];
function tempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "openrouter-configurator-"));
	dirs.push(dir);
	return dir;
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("parseConfig", () => {
	it("keeps valid routing entries and drops malformed ones", () => {
		const config = parseConfig({
			routing: {
				"anthropic/claude-sonnet-4.6": { mode: "order", providers: ["anthropic", "google"] },
				"openai/gpt-5": { mode: "only", providers: [] },
				"meta/llama": { mode: "bogus", providers: ["x"] },
				broken: "nope",
			},
		});
		assert.deepEqual(Object.keys(config.routing), ["anthropic/claude-sonnet-4.6"]);
	});

	it("survives a garbage document", () => {
		assert.deepEqual(parseConfig(null), emptyConfig());
		assert.deepEqual(parseConfig({ routing: 42, sync: [] }), emptyConfig());
	});
});

describe("setRouting", () => {
	it("stores non-empty configs and deletes cleared ones", () => {
		const config = emptyConfig();
		setRouting(config, "a/b", { mode: "ignore", providers: ["deepinfra"] });
		assert.deepEqual(config.routing["a/b"], { mode: "ignore", providers: ["deepinfra"] });
		setRouting(config, "a/b", undefined);
		assert.equal(config.routing["a/b"], undefined);
		setRouting(config, "a/c", { mode: "order", providers: [] });
		assert.equal(config.routing["a/c"], undefined);
	});
});

describe("routingPayload", () => {
	it("maps each mode onto the OpenRouter provider object", () => {
		assert.deepEqual(routingPayload({ mode: "order", providers: ["a", "b"] }), { order: ["a", "b"] });
		assert.deepEqual(routingPayload({ mode: "only", providers: ["a"] }), { only: ["a"] });
		assert.deepEqual(routingPayload({ mode: "ignore", providers: ["a"] }), { ignore: ["a"] });
		assert.equal(routingPayload(undefined), undefined);
		assert.equal(routingPayload({ mode: "only", providers: [] }), undefined);
	});
});

describe("saveConfig / loadConfig", () => {
	it("round-trips through the config file and tolerates a missing file", () => {
		const agentDir = tempAgentDir();
		assert.deepEqual(loadConfig(agentDir), emptyConfig());

		const config = emptyConfig();
		setRouting(config, "qwen/qwen3", { mode: "only", providers: ["novita"] });
		config.sync = { lastRunAt: "2026-01-01T00:00:00.000Z", added: ["new/model"], overrides: ["qwen/qwen3"] };
		saveConfig(agentDir, config);

		assert.deepEqual(loadConfig(agentDir), config);
		assert.ok(readFileSync(configPath(agentDir), "utf8").includes("novita"));
	});
});
