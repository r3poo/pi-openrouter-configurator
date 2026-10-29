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
import type { ProviderOption } from "./openrouter.ts";
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
	onSelect: (value: string) => void = () => {};
	onCancel: () => void = () => {};

	constructor(items: SelectItem[], preselect: string | undefined, theme: Theme) {
		super();
		this.allItems = items;
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

	private refilter(): void {
		const query = this.input.getValue();
		const selected = this.list.getSelectedItem()?.value;
		const items = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.description ?? ""}`)
			: this.allItems;
		const list = this.buildList(items, selected);
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
	onDone: (providers: string[]) => void = () => {};
	onCancel: () => void = () => {};

	constructor(
		private readonly mode: RoutingMode,
		private readonly providers: ProviderOption[],
		initial: string[],
		theme: Theme,
	) {
		super();
		// Keep configured providers that the endpoints API no longer lists so a save cannot silently drop them.
		const known = new Set(providers.map((provider) => provider.tag));
		this.order = [...initial];
		for (const tag of initial) if (!known.has(tag)) this.providers.push({ tag, name: `${tag} (unavailable)` });

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
		const position = this.order.indexOf(provider.tag);
		const included = position !== -1;
		const mark = !included ? "  " : this.mode === "order" ? `${position + 1}.` : this.mode === "only" ? "✓" : "✕";
		return `${mark} ${provider.name} · ${provider.tag}`;
	}

	private descriptionFor(provider: ProviderOption): string | undefined {
		const parts: string[] = [];
		if (provider.uptime !== undefined) parts.push(`${provider.uptime.toFixed(1)}% uptime`);
		if (provider.promptPricePerMillion !== undefined) parts.push(`$${provider.promptPricePerMillion}/M in`);
		return parts.length > 0 ? parts.join(" · ") : undefined;
	}

	private buildList(): SelectList {
		const items: SelectItem[] = this.providers.map((provider) => ({
			value: provider.tag,
			label: this.labelFor(provider),
			description: this.descriptionFor(provider),
		}));
		const list = new SelectList(items, Math.min(MAX_VISIBLE, Math.max(1, items.length)), getSelectListTheme(), LIST_LAYOUT);
		list.onSelect = () => this.onDone(this.order);
		list.onCancel = () => this.onCancel();
		return list;
	}

	private rebuild(): void {
		const selected = this.list.getSelectedItem()?.value;
		const list = this.buildList();
		const index = this.providers.findIndex((provider) => provider.tag === selected);
		if (index > 0) list.setSelectedIndex(index);
		this.children[this.listIndex] = list;
		this.list = list;
	}

	private move(direction: -1 | 1): void {
		const tag = this.list.getSelectedItem()?.value;
		if (!tag) return;
		const from = this.order.indexOf(tag);
		if (from === -1) return;
		const to = from + direction;
		if (to < 0 || to >= this.order.length) return;
		const next = [...this.order];
		next.splice(from, 1);
		next.splice(to, 0, tag);
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
			this.onDone(this.order);
			return;
		}
		if (keyData === " ") {
			const tag = this.list.getSelectedItem()?.value;
			if (!tag) return;
			this.order = this.order.includes(tag) ? this.order.filter((item) => item !== tag) : [...this.order, tag];
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

/** Step 3: choose providers for `mode`. Returns `[]` when the user clears the selection. */
export function pickProviders(
	ui: PickUi,
	mode: RoutingMode,
	providers: ProviderOption[],
	initial: string[],
): Promise<string[] | undefined> {
	if (providers.length === 0) return Promise.resolve(undefined);
	return ui.custom<string[] | undefined>((_tui, theme, _keybindings, done) => {
		const picker = new ProviderPicker(mode, [...providers], initial, theme);
		picker.onDone = (selected) => done(selected);
		picker.onCancel = () => done(undefined);
		return picker;
	});
}
