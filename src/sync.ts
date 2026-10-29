import { loadConfig, saveConfig } from "./config.ts";
import { deepEqual, openRouterSection, readModelsJson, writeModelsJson, type ModelsJsonFile } from "./models-json.ts";
import {
	computeOverrides,
	desiredFromUpstream,
	fetchUpstreamModels,
	OPENROUTER_API_BASE,
	toModelsJsonDefinition,
	type UpstreamModel,
} from "./openrouter.ts";
import type { CatalogModel, PluginConfig, SyncResult } from "./types.ts";

/** Pi's provider id for OpenRouter models. */
export const PROVIDER_ID = "openrouter";
export const DEFAULT_API = "openai-completions";
export const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The registry surface the sync needs (kept narrow so it stays testable). */
export interface SyncRegistry {
	getAll(): CatalogModel[];
	refresh(): Promise<unknown> | unknown;
}

export interface SyncOptions {
	agentDir: string;
	registry: SyncRegistry;
	fetchModels?: () => Promise<UpstreamModel[]>;
	now?: number;
	config?: PluginConfig;
	baseUrl?: string;
}

/** True when the catalog has never been synced or the last sync is older than 24h. */
export function isSyncDue(config: PluginConfig, now = Date.now()): boolean {
	if (!config.sync.lastRunAt) return true;
	const last = Date.parse(config.sync.lastRunAt);
	return !Number.isFinite(last) || now - last >= SYNC_INTERVAL_MS;
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** Every OpenRouter model Pi knows about, sorted for stable menus and diffs. */
export function openRouterCatalog(registry: { getAll(): CatalogModel[] }): CatalogModel[] {
	return registry
		.getAll()
		.filter((model) => model.provider === PROVIDER_ID)
		.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Reconcile Pi's OpenRouter catalog with the upstream one.
 *
 * Writes Pi's sanctioned overlay (`<agent-dir>/models.json` → `providers.openrouter`):
 * - `models[]` gains models Pi does not know yet,
 * - `modelOverrides` gains metadata that fixes stale built-in values.
 *
 * Entries the plugin wrote previously are tracked in the config so a later sync can
 * refresh or remove them without ever touching user-authored entries.
 */
export async function runSync(options: SyncOptions): Promise<SyncResult> {
	const now = options.now ?? Date.now();
	const fetchModels = options.fetchModels ?? (() => fetchUpstreamModels());
	const config = options.config ?? loadConfig(options.agentDir);

	let upstream: UpstreamModel[];
	try {
		upstream = await fetchModels();
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
			added: [],
			overrides: [],
			removed: [],
			unchanged: 0,
		};
	}
	if (upstream.length === 0) {
		return {
			ok: false,
			error: "OpenRouter returned an empty catalog; keeping the current one",
			added: [],
			overrides: [],
			removed: [],
			unchanged: 0,
		};
	}

	const file: ModelsJsonFile = readModelsJson(options.agentDir);
	const before = clone(file);
	const section = openRouterSection(file);
	const catalog = new Map(openRouterCatalog(options.registry).map((model) => [model.id, model]));
	const fallbackApi = catalog.values().next().value?.api ?? DEFAULT_API;

	const added: string[] = [];
	const overrides: string[] = [];
	const seen = new Set<string>();

	for (const model of upstream) {
		if (!model.id || seen.has(model.id)) continue;
		if (model.expiration_date) {
			const expiry = Date.parse(model.expiration_date);
			if (Number.isFinite(expiry) && expiry < now) continue;
		}
		const desired = desiredFromUpstream(model);
		if (!desired) continue;
		seen.add(model.id);

		const current = catalog.get(model.id);
		if (!current) {
			const definition = toModelsJsonDefinition(desired, fallbackApi, OPENROUTER_API_BASE);
			const models = (section.models ??= []);
			const index = models.findIndex((entry) => entry.id === model.id);
			if (index === -1) models.push(definition);
			else if (!deepEqual(models[index], definition)) models[index] = definition;
			added.push(model.id);
			continue;
		}

		const existing = section.modelOverrides?.[model.id];
		const owned = config.sync.overrides.includes(model.id);
		// A hand-written override belongs to the user; updating any of its fields would be a
		// guess about their intent, so leave the whole entry alone.
		if (existing !== undefined && !owned) continue;

		section.modelOverrides ??= {};
		const previous = existing ?? {};
		const next = computeOverrides(desired, current, previous);
		if (next) {
			section.modelOverrides[model.id] = next;
			overrides.push(model.id);
		} else if (config.sync.overrides.includes(model.id)) {
			// The built-in catalog caught up with upstream: drop the override this plugin wrote.
			delete section.modelOverrides[model.id];
		}
	}

	const removed = pruneStale(section, config, seen);

	if (!deepEqual(before, file)) writeModelsJson(options.agentDir, file);

	const nextConfig: PluginConfig = {
		...config,
		sync: {
			lastRunAt: new Date(now).toISOString(),
			added,
			overrides,
		},
	};
	saveConfig(options.agentDir, nextConfig);

	if (!deepEqual(before, file)) await options.registry.refresh();

	return {
		ok: true,
		added,
		overrides,
		removed,
		unchanged: seen.size - added.length - overrides.length,
		lastRunAt: nextConfig.sync.lastRunAt,
	};
}

/** Drop overlay entries the previous sync wrote that no longer exist upstream. */
function pruneStale(section: { models?: { id: string }[]; modelOverrides?: Record<string, unknown> }, config: PluginConfig, seen: Set<string>): string[] {
	const removed: string[] = [];

	const staleModels = new Set(config.sync.added.filter((id) => !seen.has(id)));
	if (staleModels.size > 0 && section.models) {
		section.models = section.models.filter((entry) => !staleModels.has(entry.id));
		if (section.models.length === 0) delete section.models;
	}

	const staleOverrides = new Set(config.sync.overrides.filter((id) => !seen.has(id)));
	if (staleOverrides.size > 0 && section.modelOverrides) {
		for (const id of staleOverrides) delete section.modelOverrides[id];
		if (Object.keys(section.modelOverrides).length === 0) delete section.modelOverrides;
	}

	for (const id of staleModels) removed.push(id);
	for (const id of staleOverrides) if (!staleModels.has(id)) removed.push(id);
	return removed;
}
