import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelRouting, PluginConfig, RoutingMode } from "./types.ts";

export const CONFIG_BASENAME = "openrouter-configurator.json";

export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_BASENAME);
}

export function emptyConfig(): PluginConfig {
	return { version: 1, routing: {}, sync: { added: [], overrides: [] } };
}

const ROUTING_MODES: readonly string[] = ["order", "only", "ignore"];

export function isRoutingMode(value: unknown): value is RoutingMode {
	return typeof value === "string" && ROUTING_MODES.includes(value);
}

function parseRouting(value: unknown): ModelRouting | undefined {
	if (!value || typeof value !== "object") return undefined;
	const entry = value as Record<string, unknown>;
	if (!isRoutingMode(entry.mode)) return undefined;
	const providers = Array.isArray(entry.providers)
		? entry.providers.filter((provider): provider is string => typeof provider === "string" && provider.length > 0)
		: [];
	if (providers.length === 0) return undefined;
	return { mode: entry.mode, providers };
}

function parseStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Tolerant reader: a hand-edited config must never keep the extension from loading. */
export function parseConfig(raw: unknown): PluginConfig {
	const config = emptyConfig();
	if (!raw || typeof raw !== "object") return config;
	const record = raw as Record<string, unknown>;

	if (record.routing && typeof record.routing === "object") {
		for (const [modelId, value] of Object.entries(record.routing as Record<string, unknown>)) {
			const routing = parseRouting(value);
			if (routing) config.routing[modelId] = routing;
		}
	}

	if (record.sync && typeof record.sync === "object") {
		const sync = record.sync as Record<string, unknown>;
		if (typeof sync.lastRunAt === "string") config.sync.lastRunAt = sync.lastRunAt;
		config.sync.added = parseStringArray(sync.added);
		config.sync.overrides = parseStringArray(sync.overrides);
	}

	return config;
}

export function loadConfig(agentDir: string): PluginConfig {
	try {
		return parseConfig(JSON.parse(readFileSync(configPath(agentDir), "utf8")));
	} catch {
		return emptyConfig();
	}
}

/** Atomic write so a crash mid-save cannot truncate the config. */
export function saveConfig(agentDir: string, config: PluginConfig): void {
	const path = configPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function setRouting(config: PluginConfig, modelId: string, routing: ModelRouting | undefined): void {
	if (routing && routing.providers.length > 0) config.routing[modelId] = routing;
	else delete config.routing[modelId];
}

/** A routing config the user set; `undefined` means OpenRouter's default handling. */
export function getRouting(config: PluginConfig, modelId: string): ModelRouting | undefined {
	return config.routing[modelId];
}
