import type { ModelRouting } from "./types.ts";

/** The `provider` object OpenRouter expects inside a request body. */
export function routingPayload(routing: ModelRouting | undefined): Record<string, string[]> | undefined {
	if (!routing || routing.providers.length === 0) return undefined;
	if (routing.mode === "order") return { order: routing.providers };
	if (routing.mode === "only") return { only: routing.providers };
	return { ignore: routing.providers };
}

export function describeRouting(routing: ModelRouting | undefined): string {
	if (!routing) return "default routing";
	if (routing.mode === "order") return `ordered: ${routing.providers.join(", ")}`;
	return `${routing.mode}: ${routing.providers.join(", ")}`;
}
