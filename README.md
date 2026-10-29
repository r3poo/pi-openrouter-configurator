# pi-openrouter-configurator

A Pi Agent extension for OpenRouter that the built-in connector does not cover:

- **Per-model upstream routing** — pin a model to an ordered provider list, or restrict/exclude providers.
- **Sticky sessions** — every OpenRouter request carries a session key so a conversation stays on one upstream provider.
- **App attribution** — requests report `X-OpenRouter-Title: Pi Agent` (verified against OpenRouter's [app attribution docs](https://openrouter.ai/docs/app-attribution); `X-Title` is the legacy spelling).
- **Fresh model catalog** — on startup (at most once every 24 h) and on demand, the extension adds OpenRouter models Pi does not know yet and refreshes stale metadata.

## Install

```bash
# try it without installing
pi -e /path/to/pi-openrouter-configurator/src/index.ts

# or install it as a package
pi install /path/to/pi-openrouter-configurator
```

The extension registers two commands and three hooks; it adds no tools.

## Commands

| Command | What it does |
| --- | --- |
| `/openrouter-routing` | Searchable model picker (current model first, then models with a non-default config, then the rest) → routing mode → provider picker. |
| `/openrouter-sync` | Runs the catalog sync immediately and reports what changed. |

Routing modes:

- `order` — providers are tried in the order you list them (`provider.order`).
- `only` — the routing pool is restricted to the listed providers (`provider.only`).
- `ignore` — the listed providers are excluded from the pool (`provider.ignore`).
- `default` — removes the model's entry; OpenRouter's default routing applies.

The provider picker fetches live endpoint data from `GET /v1/models/{author}/{slug}/endpoints`, so it shows the providers actually serving that model.

## Config

`$PI_AGENT_DIR/openrouter-configurator.json` (usually `~/.pi/agent/openrouter-configurator.json`):

```json
{
  "version": 1,
  "routing": {
    "anthropic/claude-sonnet-4.6": { "mode": "order", "providers": ["anthropic", "google"] },
    "deepseek/deepseek-v4.1-flash-1017": {
      "mode": "order",
      "providers": ["deepseek", "deepinfra/fp8/priority"],
      "caps": { "deepseek": 393216, "deepinfra/fp8/priority": 131072 }
    },
    "openai/gpt-5": { "mode": "ignore", "providers": ["azure"] }
  },
  "sync": {
    "lastRunAt": "2026-02-02T00:00:00.000Z",
    "added": ["brand/new-model"],
    "overrides": ["anthropic/claude-sonnet-4.6"]
  }
}
```

The file is read on every request, so hand edits take effect without a restart. It is written atomically; a malformed file is treated as empty rather than breaking the extension.

## What the network calls look like

For `openrouter` models only:

```ts
// before_provider_headers
headers["x-session-id"] = sessionName ?? sessionId;   // ≤ 256 chars
headers["X-OpenRouter-Title"] = "Pi Agent";

// before_provider_request
body.session_id = sessionName ?? sessionId;           // body wins over the header
body.provider = { order: [...] } | { only: [...] } | { ignore: [...] };
```

Sticky routing only activates when OpenRouter sees `session_id`/`x-session-id`; without it, OpenRouter falls back to hashing the opening messages.

### Routing-safe completion budgets

OpenRouter drops every endpoint that cannot honor the requested `max_tokens` **before** it applies `provider.order`/`only`, and when the whole list is filtered it silently routes to a provider you excluded. For `deepseek/deepseek-v4.1-flash-1017` Pi asks for 943,718 tokens (the largest budget of any endpoint — Morph); DeepSeek caps at 393,216 and DeepInfra at 131,072, so both were eliminated and requests landed on **Morph** despite `order: [deepseek, deepinfra]`.

The extension therefore clamps the request budget to a value the configured providers accept:

- `order` and `only` → the smallest budget across the listed providers (131,072 above). Every listed provider accepts that value, so the head of an `order` chain keeps priority *and* the later providers stay usable as fallbacks; clamping to the head's own budget would silently drop every lower-cap provider behind it.
- `ignore` → the smallest budget among the *surviving* endpoints, ignoring outliers below 1/8 of the pool's best budget (so one weak provider can't shrink every response to its own cap). The pool is every endpoint OpenRouter reports for the model, minus the ignored slugs; `deepinfra` also excludes `deepinfra/fp8/priority`.

Per-provider budgets come from `GET /v1/models/{author}/{slug}/endpoints` (`max_completion_tokens`) and are stored as `caps` next to the route — the listed providers for `order`/`only`, the whole endpoint pool for `ignore`. They are refreshed whenever you save the route in `/openrouter-routing` and backfilled at startup for hand-written entries. A request for a route that has no snapshot yet waits for that backfill (one endpoint fetch) instead of racing it, so the very first message of a session is already clamped.

## Catalog sync

`runSync` fetches `https://openrouter.ai/api/v1/models` and writes `$PI_AGENT_DIR/models.json`:

- **Missing models** are appended under `providers.openrouter.models` with `api: "openai-completions"` and the OpenRouter base URL. Their ids are recorded in `sync.added`.
- **Stale metadata** becomes a `providers.openrouter.modelOverrides` entry: modalities are only added (never removed), `contextWindow`/`maxTokens` only increase, and `cost` is rewritten when it differs. Model ids are recorded in `sync.overrides`.
- **Ownership** — only entries this plugin wrote earlier (`sync.added` / `sync.overrides`) are updated or pruned. A hand-written model or override is never modified, and a sync drops its own override once the built-in catalog has caught up with upstream.
- The model registry is refreshed afterwards, so new models show up without a restart.
- On failure nothing is written and `sync.lastRunAt` stays untouched, so the next startup retries.
- Startup sync is fire-and-forget: it never delays startup and stays silent unless it fails.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

The Pi packages are declared the same way the published extensions declare them: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as optional `peerDependencies` (Pi supplies them at runtime, nothing is bundled), plus matching `devDependencies` so `pnpm typecheck` resolves their types from npm without path mapping. If pnpm stops on `ERR_PNPM_IGNORED_BUILDS`, run `pnpm approve-builds --all` once.
