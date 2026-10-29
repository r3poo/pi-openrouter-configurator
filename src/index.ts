import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, setRouting } from "./config.ts";
import { pickModel, pickMode, pickProviders } from "./menu.ts";
import { fetchModelProviders } from "./openrouter.ts";
import { describeRouting, routingPayload } from "./routing.ts";
import { isSyncDue, openRouterCatalog, PROVIDER_ID, runSync } from "./sync.ts";
import type { PluginConfig, SyncResult } from "./types.ts";

/** OpenRouter's sticky-routing key header; the body field of the same name wins if both are set. */
export const SESSION_ID_HEADER = "x-session-id";
/** OpenRouter's app-attribution header (replaces the deprecated `X-Title`). */
export const TITLE_HEADER = "X-OpenRouter-Title";
export const TITLE_VALUE = "Pi Agent";

function isOpenRouterModel(ctx: { model: { provider: string } | undefined }): boolean {
	return ctx.model?.provider === PROVIDER_ID;
}

/** Session name when the user set one, otherwise Pi's session id. OpenRouter caps this at 256 chars. */
function sessionId(ctx: { sessionManager: { getSessionName(): string | undefined; getSessionId(): string } }): string {
	return (ctx.sessionManager.getSessionName() ?? ctx.sessionManager.getSessionId()).slice(0, 256);
}

function modelItems(ctx: ExtensionCommandContext, config: PluginConfig) {
	const currentId = ctx.model?.provider === PROVIDER_ID ? ctx.model.id : undefined;
	const catalog = openRouterCatalog(ctx.modelRegistry);
	const configured = new Set(Object.keys(config.routing));
	const items = catalog.map((model) => {
		const routing = config.routing[model.id];
		const notes: string[] = [];
		if (model.id === currentId) notes.push("current");
		if (routing) notes.push(describeRouting(routing));
		return {
			value: model.id,
			label: model.id,
			description: notes.length > 0 ? `${notes.join(" · ")}${model.name && model.name !== model.id ? ` · ${model.name}` : ""}` : model.name,
			rank: model.id === currentId ? 0 : configured.has(model.id) ? 1 : 2,
		};
	});
	items.sort((left, right) => left.rank - right.rank || left.value.localeCompare(right.value));
	return items.map(({ value, label, description }) => ({ value, label, description }));
}

async function handleRoutingCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const agentDir = getAgentDir();
	const config = loadConfig(agentDir);

	if (!ctx.hasUI) {
		ctx.ui.notify("OpenRouter routing needs the interactive UI.", "warning");
		return;
	}

	const modelId = await pickModel(
		ctx.ui,
		modelItems(ctx, config),
		ctx.model?.provider === PROVIDER_ID ? ctx.model.id : undefined,
	);
	if (!modelId) return;

	const current = config.routing[modelId];
	const mode = await pickMode(ctx.ui, current?.mode);
	if (!mode) return;

	if (mode === "default") {
		setRouting(config, modelId, undefined);
		saveConfig(agentDir, config);
		ctx.ui.notify(`${modelId}: default OpenRouter routing`, "info");
		return;
	}

	let providers;
	try {
		providers = await fetchModelProviders(modelId);
	} catch (error) {
		ctx.ui.notify(`Could not load providers for ${modelId}: ${error instanceof Error ? error.message : error}`, "error");
		return;
	}
	if (providers.length === 0) {
		ctx.ui.notify(`OpenRouter lists no endpoints for ${modelId}.`, "warning");
		return;
	}

	const selected = await pickProviders(ctx.ui, mode, providers, current?.providers ?? []);
	if (selected === undefined) return;

	setRouting(config, modelId, selected.length > 0 ? { mode, providers: selected } : undefined);
	saveConfig(agentDir, config);
	ctx.ui.notify(
		selected.length > 0 ? `${modelId}: ${mode} ${selected.join(", ")}` : `${modelId}: default OpenRouter routing`,
		"info",
	);
}

function summarize(result: SyncResult): string {
	if (!result.ok) return `OpenRouter sync failed: ${result.error ?? "unknown error"}`;
	const parts = [`${result.added.length} added`, `${result.overrides.length} updated`];
	if (result.removed.length > 0) parts.push(`${result.removed.length} removed`);
	return `OpenRouter catalog synced: ${parts.join(", ")}.`;
}

async function handleSyncCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.notify("Syncing OpenRouter catalog…", "info");
	const result = await runSync({ agentDir: getAgentDir(), registry: ctx.modelRegistry });
	ctx.ui.notify(summarize(result), result.ok ? "info" : "error");
}

export default function openRouterConfigurator(pi: ExtensionAPI): void {
	pi.registerCommand("openrouter-routing", {
		description: "Configure OpenRouter upstream provider routing per model",
		handler: handleRoutingCommand,
	});
	pi.registerCommand("openrouter-sync", {
		description: "Sync Pi's OpenRouter model catalog with openrouter.ai (adds missing models, refreshes stale metadata)",
		handler: handleSyncCommand,
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!isOpenRouterModel(ctx)) return;
		event.headers[SESSION_ID_HEADER] = sessionId(ctx);
		event.headers[TITLE_HEADER] = TITLE_VALUE;
	});

	// Upstream provider selection: OpenRouter reads `provider` from the request body.
	pi.on("before_provider_request", (event, ctx) => {
		if (!isOpenRouterModel(ctx)) return;
		const body = event.payload as { model?: unknown; provider?: unknown } | undefined;
		const modelId = typeof body?.model === "string" ? body.model : ctx.model?.id;
		if (!body || !modelId) return;
		const routing = routingPayload(loadConfig(getAgentDir()).routing[modelId]);
		if (routing) body.provider = routing;
		// Sticky routing: a stable key makes OpenRouter keep a conversation on one upstream.
		(body as { session_id?: string }).session_id = sessionId(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		const config = loadConfig(getAgentDir());
		if (!isSyncDue(config)) return;
		// Never block startup on the network; the catalog is used on the next request either way.
		void runSync({ agentDir: getAgentDir(), registry: ctx.modelRegistry, config }).then((result) => {
			if (!result.ok) ctx.ui.notify(summarize(result), "warning");
		});
	});
}
