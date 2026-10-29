import type { AppAttribution } from "./types.ts";

/** OpenRouter's app-attribution headers (replacements for the deprecated `HTTP-Referer`/`X-Title` pair). */
export const REFERER_HEADER = "HTTP-Referer";
export const TITLE_HEADER = "X-OpenRouter-Title";
export const CATEGORIES_HEADER = "X-OpenRouter-Categories";

/**
 * Pi's provider config leaves `attribution` unset, so Pi sends no `HTTP-Referer` and OpenRouter
 * files the traffic under "Unknown" — the title alone does not create an app record. These are the
 * values the plugin sends instead; OpenRouter keys the app by the *origin* of the referer, so the
 * user can point it at something they control to get their own record.
 */
export const DEFAULT_APP: AppAttribution = {
	referer: "https://pi.dev",
	title: "Pi Agent",
	categories: ["cli-agent"],
};

/** OpenRouter clamps titles to 100 characters and accepts a comma-separated category list. */
const MAX_TITLE = 100;
const MAX_CATEGORIES = 4;

/** A referer has to be an absolute http(s) URL, otherwise OpenRouter has no origin to key on. */
export function normalizeReferer(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const candidate = value.trim();
	if (candidate.length === 0) return undefined;
	try {
		const url = new URL(candidate);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		if (!url.hostname) return undefined;
		return candidate;
	} catch {
		return undefined;
	}
}

export function normalizeTitle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// A newline would break the header; OpenRouter only keeps the first line anyway.
	const title = value.replace(/[\r\n]+/g, " ").trim();
	return title.length > 0 ? title.slice(0, MAX_TITLE) : undefined;
}

export function normalizeCategories(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const categories = value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim().toLowerCase())
		.filter((item) => item.length > 0 && /^[a-z0-9][a-z0-9._-]*$/.test(item));
	return categories.length > 0 ? [...new Set(categories)].slice(0, MAX_CATEGORIES) : undefined;
}

/** Tolerant: every field falls back to its default, so a hand-edited config still attributes. */
export function parseAttribution(raw: unknown): AppAttribution {
	const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		referer: normalizeReferer(record.referer) ?? DEFAULT_APP.referer,
		title: normalizeTitle(record.title) ?? DEFAULT_APP.title,
		// An explicit `[]` means "send no categories header", so it must not fall back to the default.
		categories: Array.isArray(record.categories) ? (normalizeCategories(record.categories) ?? []) : DEFAULT_APP.categories,
	};
}

export function attributionHeaders(app: AppAttribution): Record<string, string> {
	const headers: Record<string, string> = {
		[REFERER_HEADER]: app.referer,
		[TITLE_HEADER]: app.title,
	};
	if (app.categories.length > 0) headers[CATEGORIES_HEADER] = app.categories.join(",");
	return headers;
}

/** True when the app block is exactly the default, so the config file only stores what changed. */
export function isDefaultAttribution(app: AppAttribution): boolean {
	return (
		app.referer === DEFAULT_APP.referer &&
		app.title === DEFAULT_APP.title &&
		app.categories.join(",") === DEFAULT_APP.categories.join(",")
	);
}
