import { providerSlug } from "./openrouter.ts";
import type { ModelRouting } from "./types.ts";

/**
 * Endpoints offering less than this share of the pool's best budget are treated as outliers when
 * clamping an `ignore` route. Keeping them eligible would shrink every response to whatever the
 * weakest provider accepts, so they are left to be filtered out by OpenRouter instead.
 */
const POOL_FLOOR_RATIO = 0.125;

/** The `provider` object OpenRouter expects inside a request body. */
export function routingPayload(routing: ModelRouting | undefined): Record<string, string[]> | undefined {
	if (!routing || routing.providers.length === 0) return undefined;
	if (routing.mode === "order") return { order: routing.providers };
	if (routing.mode === "only") return { only: routing.providers };
	return { ignore: routing.providers };
}

/**
 * The completion budget that keeps the configured routing intact.
 *
 * OpenRouter removes every endpoint that cannot honor `max_tokens` *before* it applies `order`/
 * `only`. Pi advertises the largest budget of any endpoint (Morph at 943,718 for
 * `deepseek/deepseek-v4.1-flash-1017`), which filters out DeepSeek (393,216) and DeepInfra
 * (131,072) — and once the whole list is filtered OpenRouter silently routes to a provider the
 * user excluded. Reproduced: 943,718 + `order: [deepseek, deepinfra/fp8/priority]` → Morph;
 * 393,216 with the same order → DeepSeek.
 *
 * `order` and `only` clamp to the smallest budget across the configured providers: every listed
 * provider accepts that value, so `order` keeps its fallbacks usable (a first provider with the
 * widest budget is not excluded by a smaller request) and `only` keeps its whole pool.
 *
 * `ignore` has no positive list, so the pool is every endpoint the snapshot knows about minus the
 * ignored ones (base slugs, so `deepinfra/fp8/priority` also excludes `deepinfra`). The clamp is
 * the smallest remaining budget above `POOL_FLOOR_RATIO` of the pool's best budget: the floor
 * stops one weak endpoint from dictating the output budget of the whole pool.
 */
export function budgetCap(routing: ModelRouting | undefined, requested: number | undefined): number | undefined {
	if (!routing || !routing.caps) return undefined;
	const cap = routing.mode === "ignore" ? poolCap(routing) : listedCap(routing);
	return cap === undefined || requested === undefined || requested <= cap ? undefined : cap;
}

/** Tightest budget among the providers the user listed; they all accept it, so none is dropped. */
function listedCap(routing: ModelRouting): number | undefined {
	const caps = routing.providers
		.map((provider) => routing.caps?.[provider])
		.filter((cap): cap is number => typeof cap === "number" && cap > 0);
	const [smallest, ...rest] = caps;
	return smallest === undefined ? undefined : Math.min(smallest, ...rest);
}

/** Tightest budget among the providers that survive an `ignore` route, outliers excluded. */
function poolCap(routing: ModelRouting): number | undefined {
	const ignored = new Set(routing.providers.map((provider) => providerSlug(provider)));
	const caps = Object.entries(routing.caps ?? {})
		.filter(([slug, cap]) => !ignored.has(providerSlug(slug)) && typeof cap === "number" && cap > 0)
		.map(([, cap]) => cap);
	const strongest = Math.max(...caps);
	if (!Number.isFinite(strongest)) return undefined;
	const viable = caps.filter((cap) => cap >= strongest * POOL_FLOOR_RATIO);
	return Math.min(...viable);
}

export function describeRouting(routing: ModelRouting | undefined): string {
	if (!routing) return "default routing";
	const cap = budgetCap(routing, Number.POSITIVE_INFINITY);
	const suffix = cap === undefined ? "" : ` (max ${cap.toLocaleString("en-US")} out)`;
	if (routing.mode === "order") return `ordered: ${routing.providers.join(", ")}${suffix}`;
	return `${routing.mode}: ${routing.providers.join(", ")}${suffix}`;
}
