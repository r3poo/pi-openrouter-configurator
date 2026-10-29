import type { CatalogModel } from "./types.ts";
import type { ModelsJsonModel } from "./models-json.ts";

export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 15_000;

export interface UpstreamPricing {
	prompt?: string;
	completion?: string;
	input_cache_read?: string;
	input_cache_write?: string;
}

export interface UpstreamModel {
	id: string;
	name?: string;
	created?: number;
	context_length?: number | null;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: UpstreamPricing;
	top_provider?: {
		context_length?: number | null;
		max_completion_tokens?: number | null;
	};
	supported_parameters?: string[];
	expiration_date?: string | null;
}

export interface UpstreamEndpoint {
	tag: string;
	provider_name?: string;
	status?: number;
	uptime_last_30m?: number;
	quantization?: string;
	context_length?: number | null;
	max_completion_tokens?: number | null;
	pricing?: UpstreamPricing;
}

/** A provider the user can route to, as offered by the routing menu. */
export interface ProviderOption {
	tag: string;
	name: string;
	uptime?: number;
	promptPricePerMillion?: number;
}

/** Model metadata derived from the public catalog — the plugin's idea of "current". */
export interface DesiredModel {
	id: string;
	name: string;
	input: ("text" | "image")[];
	reasoning: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

interface FetchOptions {
	baseUrl?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

async function getJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const signal = options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const response = await fetchImpl(url, {
		headers: { Accept: "application/json" },
		signal,
	});
	if (!response.ok) throw new Error(`OpenRouter ${response.status} ${response.statusText} for ${url}`);
	return (await response.json()) as T;
}

/** GET /models — the public catalog (no API key required). */
export async function fetchUpstreamModels(options: FetchOptions = {}): Promise<UpstreamModel[]> {
	const base = options.baseUrl ?? OPENROUTER_API_BASE;
	const body = await getJson<{ data?: UpstreamModel[] }>(`${base}/models`, options);
	return Array.isArray(body.data) ? body.data : [];
}

/** GET /models/{id}/endpoints — the providers currently serving one model. */
export async function fetchModelProviders(modelId: string, options: FetchOptions = {}): Promise<ProviderOption[]> {
	const base = options.baseUrl ?? OPENROUTER_API_BASE;
	const body = await getJson<{ data?: { endpoints?: UpstreamEndpoint[] } }>(
		`${base}/models/${modelId}/endpoints`,
		options,
	);
	const endpoints = body.data?.endpoints ?? [];
	const seen = new Set<string>();
	const providers: ProviderOption[] = [];
	for (const endpoint of endpoints) {
		if (!endpoint.tag || seen.has(endpoint.tag)) continue;
		seen.add(endpoint.tag);
		providers.push({
			tag: endpoint.tag,
			name: endpoint.provider_name ?? endpoint.tag,
			uptime: endpoint.uptime_last_30m,
			promptPricePerMillion: perMillion(endpoint.pricing?.prompt),
		});
	}
	return providers.sort((left, right) => (right.uptime ?? 0) - (left.uptime ?? 0) || left.tag.localeCompare(right.tag));
}

/** OpenRouter prices are USD per token; Pi stores USD per million tokens. */
export function perMillion(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return undefined;
	return Number((parsed * 1_000_000).toFixed(6));
}

/** Pi requires all four cost rates; OpenRouter omits cache rates when it does not report them. */
function fullCost(cost: DesiredModel["cost"]): { input: number; output: number; cacheRead: number; cacheWrite: number } {
	return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead ?? 0, cacheWrite: cost.cacheWrite ?? 0 };
}

function round(value: number): number {
	return Number(value.toFixed(6));
}

export function isChatModel(model: UpstreamModel): boolean {
	const outputs = model.architecture?.output_modalities;
	if (!outputs || outputs.length === 0) return true;
	return outputs.includes("text");
}

export function isExpired(model: UpstreamModel, now = Date.now()): boolean {
	if (!model.expiration_date) return false;
	const expiry = Date.parse(model.expiration_date);
	return Number.isFinite(expiry) && expiry < now;
}

/** Map an upstream catalog entry onto the metadata Pi cares about. */
export function desiredFromUpstream(model: UpstreamModel): DesiredModel | undefined {
	if (!model.id || !isChatModel(model)) return undefined;

	const modalities = model.architecture?.input_modalities ?? ["text"];
	const input: ("text" | "image")[] = ["text"];
	if (modalities.includes("image")) input.push("image");

	const prompt = perMillion(model.pricing?.prompt);
	const completion = perMillion(model.pricing?.completion);
	if (prompt === undefined || completion === undefined) return undefined;

	const cacheRead = perMillion(model.pricing?.input_cache_read);
	const cacheWrite = perMillion(model.pricing?.input_cache_write);
	const contextWindow = model.context_length ?? model.top_provider?.context_length ?? undefined;
	const maxTokens = model.top_provider?.max_completion_tokens ?? undefined;

	return {
		id: model.id,
		name: model.name ?? model.id,
		input,
		reasoning: model.supported_parameters?.includes("reasoning") === true,
		contextWindow: contextWindow ?? undefined,
		maxTokens: maxTokens ?? undefined,
		cost: {
			input: round(prompt),
			output: round(completion),
			...(cacheRead === undefined ? {} : { cacheRead }),
			...(cacheWrite === undefined ? {} : { cacheWrite }),
		},
	};
}

/** A full models.json `models[]` entry, used for models Pi's catalog does not know. */
export function toModelsJsonDefinition(desired: DesiredModel, api: string, baseUrl?: string): ModelsJsonModel {
	return {
		id: desired.id,
		name: desired.name,
		api,
		...(baseUrl ? { baseUrl } : {}),
		reasoning: desired.reasoning,
		input: desired.input,
		cost: fullCost(desired.cost),
		...(desired.contextWindow === undefined ? {} : { contextWindow: desired.contextWindow }),
		...(desired.maxTokens === undefined ? {} : { maxTokens: desired.maxTokens }),
	};
}

function closeEnough(left: number | undefined, right: number | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return Math.abs(left - right) <= Math.max(1e-6, Math.abs(left) * 1e-4);
}

/** Limits are raised but never lowered: lower local values may be per-key personalized limits. */
function raises(desired: number | undefined, current: number | undefined): boolean {
	return desired !== undefined && (current === undefined || desired > current);
}

function addsModality(current: readonly string[] | undefined, desired: readonly string[]): boolean {
	const existing = new Set(current ?? ["text"]);
	return desired.some((modality) => !existing.has(modality));
}

/**
 * Diff upstream metadata against the catalog Pi currently exposes.
 *
 * `previous` is the override this plugin wrote last time. Fields present there are always
 * rewritten, so the overlay stays authoritative for what it manages instead of flip-flopping
 * between "pi's stale value" and "our value" on every sync.
 */
export function computeOverrides(
	desired: DesiredModel,
	current: CatalogModel,
	previous: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
	const next: Record<string, unknown> = {};
	const managed = (field: string) => previous[field] !== undefined;

	if (managed("name") || (current.name !== undefined && current.name !== desired.name)) next.name = desired.name;
	if (managed("reasoning") || (desired.reasoning && current.reasoning !== true)) next.reasoning = true;
	if (managed("input") || addsModality(current.input, desired.input)) next.input = desired.input;
	if (managed("contextWindow") || raises(desired.contextWindow, current.contextWindow)) {
		if (desired.contextWindow !== undefined) next.contextWindow = desired.contextWindow;
	}
	if (managed("maxTokens") || raises(desired.maxTokens, current.maxTokens)) {
		if (desired.maxTokens !== undefined) next.maxTokens = desired.maxTokens;
	}
	const costDiffers =
		!closeEnough(desired.cost.input, current.cost?.input) ||
		!closeEnough(desired.cost.output, current.cost?.output) ||
		(desired.cost.cacheRead !== undefined && !closeEnough(desired.cost.cacheRead, current.cost?.cacheRead)) ||
		(desired.cost.cacheWrite !== undefined && !closeEnough(desired.cost.cacheWrite, current.cost?.cacheWrite));
	if (managed("cost") || costDiffers) next.cost = fullCost(desired.cost);

	return Object.keys(next).length > 0 ? next : undefined;
}
