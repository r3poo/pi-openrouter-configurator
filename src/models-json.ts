import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Pi's sanctioned model-catalog overlay lives in `<agent-dir>/models.json`.
 * `providers.openrouter.models` upserts models (replacing same-id entries) and
 * `providers.openrouter.modelOverrides` patches metadata of built-in models.
 */
export interface ModelsJsonModel {
	id: string;
	[key: string]: unknown;
}

export interface ModelsJsonProvider {
	models?: ModelsJsonModel[];
	modelOverrides?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
}

export interface ModelsJsonFile {
	providers?: Record<string, ModelsJsonProvider>;
	[key: string]: unknown;
}

export const MODELS_BASENAME = "models.json";

export function modelsJsonPath(agentDir: string): string {
	return join(agentDir, MODELS_BASENAME);
}

export function readModelsJson(agentDir: string): ModelsJsonFile {
	try {
		const parsed: unknown = JSON.parse(readFileSync(modelsJsonPath(agentDir), "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as ModelsJsonFile) : {};
	} catch {
		return {};
	}
}

export function writeModelsJson(agentDir: string, file: ModelsJsonFile): void {
	const path = modelsJsonPath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

/** Get (creating if needed) the `providers.openrouter` section of models.json. */
export function openRouterSection(file: ModelsJsonFile): ModelsJsonProvider {
	file.providers ??= {};
	file.providers.openrouter ??= {};
	return file.providers.openrouter;
}

export function deepEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		return left.every((item, index) => deepEqual(item, right[index]));
	}
	const leftEntries = Object.entries(left as Record<string, unknown>);
	const rightRecord = right as Record<string, unknown>;
	if (leftEntries.length !== Object.keys(rightRecord).length) return false;
	return leftEntries.every(([key, value]) => deepEqual(value, rightRecord[key]));
}
