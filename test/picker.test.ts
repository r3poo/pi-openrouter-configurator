import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fuzzyFilter, type SelectItem } from "@earendil-works/pi-tui";
import { pickModel } from "../src/menu.ts";

const DOWN = "\x1b[B";
const BACKSPACE = "\x7f";
const ENTER = "\r";

const ITEMS: SelectItem[] = [
	{ value: "openai/gpt-6.1-terra", label: "gpt-6.1-terra", description: "OpenAI: GPT-6.1 Terra" },
	{ value: "openai/gpt-6.1-terra-mini", label: "gpt-6.1-terra-mini", description: "OpenAI: GPT-6.1 Terra Mini" },
	{ value: "anthropic/claude-sonnet", label: "claude-sonnet", description: "Anthropic: Claude Sonnet" },
];

// The menu only styles text; identity is enough to drive it headless.
const THEME = { fg: (_token: string, text: string) => text, bold: (text: string) => text };

interface Picker {
	handleInput(keyData: string): void;
	selection: string | undefined;
}

function openMenu(items: SelectItem[], preselect?: string) {
	let picker: Picker | undefined;
	const ui = {
		custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Picker) =>
			new Promise<unknown>((resolve) => {
				picker = factory({}, THEME, {}, resolve);
			}),
	};
	const result = pickModel(ui as never, items, preselect);
	const current = () => {
		if (!picker) throw new Error("menu did not mount");
		return picker;
	};
	return { current, result };
}

function topMatch(query: string, items: SelectItem[] = ITEMS): string {
	return fuzzyFilter(items, query, (item) => `${item.value} ${item.description ?? ""}`)[0]!.value;
}

describe("model picker", () => {
	it("opens on the model it was told to preselect", () => {
		const { current } = openMenu(ITEMS, "openai/gpt-6.1-terra-mini");
		assert.equal(current().selection, "openai/gpt-6.1-terra-mini");
	});

	it("moves the cursor to the top match while typing", () => {
		// Preselected model is not index 0, so a selection that survives filtering would sit below the top.
		const { current } = openMenu(ITEMS, "openai/gpt-6.1-terra-mini");
		for (const character of "gpt") current().handleInput(character);
		assert.equal(current().selection, topMatch("gpt"));
	});

	it("jumps back to the top when typing after scrolling", () => {
		const { current } = openMenu(ITEMS, "openai/gpt-6.1-terra-mini");
		current().handleInput("g");
		const top = topMatch("g");
		current().handleInput(DOWN);
		assert.notEqual(current().selection, top, "arrow key should have moved off the top row");

		// Another keystroke re-filters; the cursor belongs on the best match, not wherever it was left.
		current().handleInput("p");
		assert.equal(current().selection, topMatch("gp"));
	});

	it("returns to the preselected model when the query is cleared", () => {
		const { current } = openMenu(ITEMS, "openai/gpt-6.1-terra-mini");
		current().handleInput("g");
		assert.notEqual(current().selection, "openai/gpt-6.1-terra-mini");
		current().handleInput(BACKSPACE);
		assert.equal(current().selection, "openai/gpt-6.1-terra-mini");
	});

	it("confirms the top match on enter without pressing down", async () => {
		const { current, result } = openMenu(ITEMS);
		for (const character of "claude") current().handleInput(character);
		current().handleInput(ENTER);
		assert.equal(await result, "anthropic/claude-sonnet");
	});
});
