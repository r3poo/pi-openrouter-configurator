/** Upstream routing modes that map 1:1 onto OpenRouter's `provider` request object. */
export type RoutingMode = "order" | "only" | "ignore";

/** A non-default routing configuration for one OpenRouter model id. */
export interface ModelRouting {
	mode: RoutingMode;
	/** Provider slugs, in priority order for `order`. */
	providers: string[];
	/**
	 * Completion budget each provider accepts, snapshotted from `/models/{id}/endpoints` when the
	 * routing was saved. OpenRouter drops endpoints that cannot honor `max_tokens`, which silently
	 * overrides `order`; the snapshot lets the request clamp the budget so the routing holds.
	 * Keyed by base provider slug; `order`/`only` only need their listed providers, while `ignore`
	 * snapshots the whole endpoint pool because its clamp applies to whatever survives.
	 */
	caps?: Record<string, number>;
}

/** Bookkeeping for the catalog sync so it can tell "our" models.json entries from the user's. */
export interface SyncState {
	/** ISO timestamp of the last successful sync. */
	lastRunAt?: string;
	/** Model ids this plugin added to models.json. */
	added: string[];
	/** Model ids this plugin wrote `modelOverrides` for. */
	overrides: string[];
}

export interface PluginConfig {
	version: 1;
	/** Keyed by OpenRouter model id, e.g. `anthropic/claude-sonnet-4.6`. */
	routing: Record<string, ModelRouting>;
	sync: SyncState;
}

/** Minimal shape of a Pi model, enough to diff against OpenRouter's catalog. */
export interface CatalogModel {
	id: string;
	/** Pi provider id, e.g. "openrouter"; used to scope the sync to one catalog. */
	provider?: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	input?: readonly string[];
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

/** Outcome of one catalog sync, reported by `/openrouter-sync` and the startup sync. */
export interface SyncResult {
	ok: boolean;
	/** Model ids added to models.json because Pi's catalog lacked them. */
	added: string[];
	/** Model ids whose metadata override was written or refreshed. */
	overrides: string[];
	/** Model ids dropped from models.json because upstream no longer lists them. */
	removed: string[];
	/** Catalogs entries already matching upstream. */
	unchanged: number;
	error?: string;
	lastRunAt?: string;
}
