import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	SelectList,
	Spacer,
	Text,
	type Component,
	type SelectItem,
} from "@earendil-works/pi-tui";
import {
	DynamicBorder,
	getSelectListTheme,
	type ExtensionUIContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { providerSlug, type ProviderOption } from "./openrouter.ts";
import type { RoutingMode } from "./types.ts";

const LIST_LAYOUT = { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 56 };
const MAX_VISIBLE = 12;

/**
 * Searchable model picker: `Input` collects the query, `SelectList` renders the
 * matches, and the container routes each keystroke to whichever one should own it.
 */
class ModelPicker extends Container {
	private input: Input;
	private list: SelectList;
	private readonly allItems: SelectItem[];
	private listIndex = 0;
	private readonly preselect: string | undefined;
	onSelect: (value: string) => void = () => {};
	onCancel: () => void = () => {};

	constructor(items: SelectItem[], preselect: string | undefined, theme: Theme) {
		super();
		this.allItems = items;
		this.preselect = preselect;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("OpenRouter routing — model")), 0, 0));
		this.addChild(new Text(theme.fg("muted", "Type to search, ↑↓ to move, enter to choose."), 0, 0));
		this.addChild(new Spacer(1));

		this.input = new Input({ placeholder: "search models…" });
		this.input.onSubmit = () => this.list.handleInput("\r");
		this.input.onEscape = () => this.onCancel();
		this.input.focused = true;
		this.addChild(this.input);
		this.addChild(new Spacer(1));

		this.list = this.buildList(items, preselect);
		this.listIndex = this.children.length;
		this.addChild(this.list);
		this.addChild(new DynamicBorder());
	}

	private buildList(items: SelectItem[], preselect: string | undefined): SelectList {
		const list = new SelectList(items, Math.min(MAX_VISIBLE, Math.max(1, items.length)), getSelectListTheme(), LIST_LAYOUT);
		const index = items.findIndex((item) => item.value === preselect);
		if (index > 0) list.setSelectedIndex(index);
		list.onSelect = (item) => this.onSelect(item.value);
		list.onCancel = () => this.onCancel();
		return list;
	}

	/** Current selection; used by the caller after the menu resolves, and by tests. */
	get selection(): string | undefined {
		return this.list.getSelectedItem()?.value;
	}

	private refilter(): void {
		const query = this.input.getValue();
		const items = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.description ?? ""}`)
			: this.allItems;
		// A fresh list starts on its first row, so typing puts the cursor on the best match instead of
		// dragging the old selection around (which also scrolled the view to keep it visible).
		// Clearing the query returns to the model the menu opened on.
		const list = this.buildList(items, query ? undefined : this.preselect);
		this.children[this.listIndex] = list;
		this.list = list;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "tui.select.down") || kb.matches(keyData, "tui.select.cancel")) {
			this.list.handleInput(keyData);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			// The search field owns enter, so "search then hit enter" selects the top match.
			const item = this.list.getSelectedItem();
			if (item) this.onSelect(item.value);
			return;
		}
		this.input.handleInput(keyData);
		this.refilter();
	}

	override invalidate(): void {
		super.invalidate();
		this.input.invalidate();
		this.list.invalidate();
	}
}

/** Providers shown as toggle rows; `SelectList` handles navigation, the container owns the toggles. */
class ProviderPicker extends Container {
	private list: SelectList;
	private listIndex = 0;
	private order: string[];
	private readonly widths: SpecWidths;
	// Plain fields, not constructor parameter properties: Node's strip-only TypeScript (which the test
	// runner uses) cannot compile parameter properties.
	private readonly mode: RoutingMode;
	private readonly providers: ProviderOption[];
	onDone: (providers: string[], caps: Record<string, number>) => void = () => {};
	onCancel: () => void = () => {};

	constructor(mode: RoutingMode, providers: ProviderOption[], initial: string[], theme: Theme) {
		super();
		this.mode = mode;
		this.providers = providers;
		this.widths = specWidths(providers);
		const known = new Set(providers.map((provider) => provider.slug));
		// Older configs stored endpoint tags; routing accepts either, the menu works in slugs.
		const normalized = initial.map((entry) => (known.has(entry) ? entry : providerSlug(entry)));
		this.order = [...new Set(normalized)];
		// Keep configured providers that the endpoints API no longer lists so a save cannot silently drop them.
		for (const slug of this.order) {
			if (!known.has(slug)) providers.push({ slug, name: `${slug} (unavailable)` });
		}
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(`OpenRouter routing — ${MODE_TITLES[mode]}`)), 0, 0));
		this.addChild(new Text(theme.fg("muted", MODE_HINTS[mode]), 0, 0));
		this.addChild(new Spacer(1));
		this.list = this.buildList();
		this.listIndex = this.children.length;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "↑↓ move · space toggle · J/K reorder · enter save · esc cancel"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	private labelFor(provider: ProviderOption): string {
		const position = this.order.indexOf(provider.slug);
		const included = position !== -1;
		const mark = !included ? "  " : this.mode === "order" ? `${position + 1}.` : this.mode === "only" ? "✓" : "✕";
		return `${mark} ${provider.name}`;
	}

	private descriptionFor(provider: ProviderOption): string {
		return specRow(provider, this.widths);
	}

	/** Completion budgets for the selected providers, so a request can stay inside their limits. */
	private capsFor(selected: string[]): Record<string, number> {
		if (this.mode === "ignore") return {};
		const caps: Record<string, number> = {};
		for (const slug of selected) {
			const cap = this.providers.find((provider) => provider.slug === slug)?.maxCompletionTokens;
			if (cap !== undefined) caps[slug] = cap;
		}
		return caps;
	}

	private finish(): void {
		this.onDone(this.order, this.capsFor(this.order));
	}

	private buildList(): SelectList {
		const items: SelectItem[] = this.providers.map((provider) => ({
			value: provider.slug,
			label: this.labelFor(provider),
			description: this.descriptionFor(provider),
		}));
		const list = new SelectList(items, Math.min(MAX_VISIBLE, Math.max(1, items.length)), getSelectListTheme(), LIST_LAYOUT);
		list.onSelect = () => this.finish();
		list.onCancel = () => this.onCancel();
		return list;
	}

	private rebuild(): void {
		const selected = this.list.getSelectedItem()?.value;
		const list = this.buildList();
		const index = this.providers.findIndex((provider) => provider.slug === selected);
		if (index > 0) list.setSelectedIndex(index);
		this.children[this.listIndex] = list;
		this.list = list;
	}

	private move(direction: -1 | 1): void {
		const slug = this.list.getSelectedItem()?.value;
		if (!slug) return;
		const from = this.order.indexOf(slug);
		if (from === -1) return;
		const to = from + direction;
		if (to < 0 || to >= this.order.length) return;
		const next = [...this.order];
		next.splice(from, 1);
		next.splice(to, 0, slug);
		this.order = next;
		this.rebuild();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "tui.select.down") || kb.matches(keyData, "tui.select.cancel")) {
			this.list.handleInput(keyData);
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.finish();
			return;
		}
		if (keyData === " ") {
			const slug = this.list.getSelectedItem()?.value;
			if (!slug) return;
			this.order = this.order.includes(slug) ? this.order.filter((item) => item !== slug) : [...this.order, slug];
			this.rebuild();
			return;
		}
		if (this.mode === "order" && (keyData === "K" || keyData === "J")) this.move(keyData === "K" ? -1 : 1);
	}

	override invalidate(): void {
		super.invalidate();
		this.list.invalidate();
	}
}

/** 943718 → "943.7K"; keeps provider limits readable in a one-line description. */
export function compactTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}K`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

export interface SpecWidths {
	slug: number;
	uptime: number;
	price: number;
	maxOut: number;
	/** Decimals every price cell in this list uses, so decimal points stack. */
	precision: number;
}

/**
 * One price precision for the whole column: sub-cent models would otherwise round to `$0.00`, while
 * a fixed number of decimals keeps the digits — and therefore the decimal point — in one place.
 */
export function pricePrecision(providers: readonly ProviderOption[]): number {
	const prices = providers
		.map((provider) => provider.promptPricePerMillion)
		.filter((price): price is number => price !== undefined && price > 0);
	const cheapest = prices.length > 0 ? Math.min(...prices) : 1;
	if (cheapest >= 0.1) return 2;
	if (cheapest >= 0.01) return 3;
	if (cheapest >= 0.001) return 4;
	return 5;
}

interface SpecCells {
	uptime?: string;
	price?: string;
	maxOut?: string;
}

function specCells(provider: ProviderOption, precision: number): SpecCells {
	return {
		uptime: provider.uptime === undefined ? undefined : `${provider.uptime.toFixed(1)}% up`,
		price:
			provider.promptPricePerMillion === undefined
				? undefined
				: provider.promptPricePerMillion === 0
					? "free"
					: `$${provider.promptPricePerMillion.toFixed(precision)}/M in`,
		maxOut:
			provider.maxCompletionTokens === undefined ? undefined : `max ${compactTokens(provider.maxCompletionTokens)} out`,
	};
}

/** Column widths for a provider list, measured over every row so cells do not shift while toggling. */
export function specWidths(providers: readonly ProviderOption[]): SpecWidths {
	const precision = pricePrecision(providers);
	const widths: SpecWidths = { slug: 0, uptime: 0, price: 0, maxOut: 0, precision };
	for (const provider of providers) {
		const cells = specCells(provider, precision);
		widths.slug = Math.max(widths.slug, provider.slug.length);
		widths.uptime = Math.max(widths.uptime, cells.uptime?.length ?? 0);
		widths.price = Math.max(widths.price, cells.price?.length ?? 0);
		widths.maxOut = Math.max(widths.maxOut, cells.maxOut?.length ?? 0);
	}
	return widths;
}

/**
 * `slug  uptime  price  max-out` with every numeric cell right-aligned, so the figures stack even
 * when a provider leaves a field unreported. Units live inside the cells (`% up`, `/M in`, `max … out`)
 * because the description column starts at a width the list decides, so a separate header row could
 * not be kept in alignment.
 */
export function specRow(provider: ProviderOption, widths: SpecWidths): string {
	const cells = specCells(provider, widths.precision);
	const slot = (cell: string | undefined, width: number) => (cell ?? "").padStart(width);
	const parts = [provider.slug.padEnd(widths.slug)];
	// A column nobody in this list reports collapses instead of leaving a stray separator.
	for (const [cell, width] of [
		[cells.uptime, widths.uptime],
		[cells.price, widths.price],
		[cells.maxOut, widths.maxOut],
	] as const) {
		if (width > 0) parts.push(slot(cell, width));
	}
	return parts.join("  ").trimEnd();
}

const MODE_TITLES: Record<RoutingMode, string> = {
	order: "ordered",
	only: "only",
	ignore: "ignore",
};

const MODE_HINTS: Record<RoutingMode, string> = {
	order: "Providers are tried in the listed order (OpenRouter `order`).",
	only: "Only the selected providers serve this model (OpenRouter `only`).",
	ignore: "The selected providers never serve this model (OpenRouter `ignore`).",
};

const MODE_ITEMS: SelectItem[] = [
	{ value: "order", label: "ordered", description: "Try providers in a specific order — OpenRouter `order`" },
	{ value: "only", label: "only", description: "Restrict the pool to selected providers — OpenRouter `only`" },
	{ value: "ignore", label: "ignore", description: "Exclude providers from the pool — OpenRouter `ignore`" },
	{ value: "default", label: "default", description: "Clear the routing config and use OpenRouter's default routing" },
];

type PickUi = Pick<ExtensionUIContext, "custom">;

/** Step 1: choose a model. */
export function pickModel(ui: PickUi, items: SelectItem[], preselect?: string): Promise<string | undefined> {
	if (items.length === 0) return Promise.resolve(undefined);
	return ui.custom<string | undefined>((_tui, theme, _keybindings, done) => {
		const picker = new ModelPicker(items, preselect, theme);
		picker.onSelect = (value) => done(value);
		picker.onCancel = () => done(undefined);
		return picker;
	});
}

/** Step 2: choose the routing mode. */
export function pickMode(ui: PickUi, current?: RoutingMode): Promise<RoutingMode | "default" | undefined> {
	return ui.custom<RoutingMode | "default" | undefined>((_tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder());
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("accent", theme.bold("OpenRouter routing — mode")), 0, 0));
		container.addChild(new Spacer(1));
		const list = new SelectList(MODE_ITEMS, MODE_ITEMS.length, getSelectListTheme(), LIST_LAYOUT);
		const index = MODE_ITEMS.findIndex((item) => item.value === (current ?? "default"));
		if (index > 0) list.setSelectedIndex(index);
		list.onSelect = (item) => done(item.value as RoutingMode | "default");
		list.onCancel = () => done(undefined);
		container.addChild(list);
		container.addChild(new DynamicBorder());
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (keyData: string) => list.handleInput(keyData),
		};
	});
}

export interface ProviderSelection {
	providers: string[];
	/** Completion budget per selected provider, empty for `ignore`. */
	caps: Record<string, number>;
}

/** Step 3: choose providers for `mode`. Returns an empty list when the user clears the selection. */
export function pickProviders(
	ui: PickUi,
	mode: RoutingMode,
	providers: ProviderOption[],
	initial: string[],
): Promise<ProviderSelection | undefined> {
	if (providers.length === 0) return Promise.resolve(undefined);
	return ui.custom<ProviderSelection | undefined>((_tui, theme, _keybindings, done) => {
		const picker = new ProviderPicker(mode, [...providers], initial, theme);
		picker.onDone = (selected, caps) => done({ providers: selected, caps });
		picker.onCancel = () => done(undefined);
		return picker;
	});
}
