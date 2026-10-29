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

`tsconfig.json` maps `@earendil-works/*` to the installed Pi release (`~/.pi/agent/install/releases/<version>/node_modules/...`). Update those paths after a Pi upgrade. At runtime Pi provides these modules itself; they are not bundled.
