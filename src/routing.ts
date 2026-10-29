import type { ModelRouting } from "./types.ts";

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
 * Both `order` and `only` clamp to the smallest budget across the configured providers: every
 * listed provider accepts that value, so `order` keeps its fallbacks usable (a first provider
 * with the widest budget is not excluded by a smaller request) and `only` keeps its whole pool.
 * `ignore` is left alone: the remaining pool is OpenRouter's choice, not the user's, and with no
 * positive list there is nothing to clamp to.
 */
export function budgetCap(routing: ModelRouting | undefined, requested: number | undefined): number | undefined {
	if (!routing || routing.mode === "ignore" || !routing.caps) return undefined;
	const caps = routing.providers
		.map((provider) => routing.caps?.[provider])
		.filter((cap): cap is number => typeof cap === "number" && cap > 0);
	const [smallest, ...rest] = caps;
	if (smallest === undefined) return undefined;
	const cap = Math.min(smallest, ...rest);
	return requested === undefined || requested <= cap ? undefined : cap;
}

export function describeRouting(routing: ModelRouting | undefined): string {
	if (!routing) return "default routing";
	const cap = budgetCap(routing, Number.POSITIVE_INFINITY);
	const suffix = cap === undefined ? "" : ` (max ${cap.toLocaleString("en-US")} out)`;
	if (routing.mode === "order") return `ordered: ${routing.providers.join(", ")}${suffix}`;
	return `${routing.mode}: ${routing.providers.join(", ")}${suffix}`;
}
