# OMP × omp-cursor-sdk: Integration Architecture

This document explains, in full detail, how the `omp-cursor-sdk` plugin works
inside OMP (Oh My Pi, `@oh-my-pi` 17.x). It covers the loading lifecycle,
provider registration, model discovery, authentication, the turn path, the
OMP API surfaces the port had to adapt, and the known OMP-side behaviors and
limitations. All facts in this document were verified live against OMP
17.3.0 (2026-08-13..16).

---

## 1. Why this plugin exists

Cursor does not expose an OpenAI-compatible chat API. Verified facts:

- The Cursor Cloud Agents API (`api.cursor.com`) is an agent-orchestration
  REST API: `/v1/agents`, `/v1/agents/{id}/runs`, `/v1/models`, `/v1/me`,
  `/v1/repositories`, `/v1/sub-tokens`. It has **no**
  `/v1/chat/completions`, `/v1/responses`, or `/v1/completions` (all probe
  as 404).
- Therefore Cursor cannot be a plain `models.yml` provider in OMP, which
  requires an OpenAI-compatible endpoint.
- The working integration is the `@cursor/sdk` agent runtime: the agent
  **loop runs locally** (tool calls, sessions, thinking), while model
  inference is served by Cursor's backend, authenticated with a Cursor
  Dashboard API key (`crsr_...`).

`omp-cursor-sdk` is the OMP port of `fitchmultz/pi-cursor-sdk` (a Pi 0.84
provider extension). Pi and OMP are forks with diverged APIs; the port
remapped every import and adapted every drifted surface (see §7).

## 2. How OMP loads the plugin

- Install: `omp plugin install --force git:github.com/LoneExile/omp-cursor-sdk#omp-port`.
- OMP stores plugins under `~/.omp/plugins/` and loads each plugin's
  extension entry (the `pi.extensions` field in `package.json` →
  `./src/index.ts`) at session start, during the `loadExtensions` startup
  phase.
- The extension's default export receives the OMP `ExtensionAPI` object
  (`pi`). Plugins are loaded per session process: a fresh `omp` invocation
  loads the plugin fresh; the plugin does **not** persist between sessions.
- The plugin's `@oh-my-pi/*` packages are declared as regular `dependencies`
  (not dev/peer): OMP's plugin installer does not install devDependencies,
  and the host loader does not map every `@oh-my-pi` subpath for plugin
  imports (`@oh-my-pi/omptype/typebox` failed to resolve when they were
  devDeps).

## 3. Provider registration and model discovery

### 3.1 Registration

At load, the extension calls:

```
pi.registerProvider("cursor", {
  baseUrl: "https://cursor.com",
  apiKey: CURSOR_API_KEY_CONFIG_VALUE,   // placeholder, see §4
  api: "cursor-sdk",                     // custom transport; OMP honors provider-supplied streamSimple
  models,                                // discovered catalog
  streamSimple: streamCursorLazy,        // the whole turn path (§5)
});
```

OMP's model registry accepts a provider-supplied `streamSimple` ("If provider
has streamSimple: registers a custom API streaming function"), so the
unknown `api: "cursor-sdk"` value is carried as a label; the custom
`streamSimple` is what actually runs turns.

### 3.2 Model discovery

- `discoverModels()` loads `@cursor/sdk`'s `Cursor.models.list()` with the
  resolved API key.
- The raw SDK catalog is **35 models** (composer-2.5, claude-opus-5,
  claude-fable-5, grok-4.6, gpt-5.6-sol/terra/luna, gemini-3.x, kimi-k3,
  glm-5.2, `default`/Auto, ...), each with `parameters` (effort, fast,
  thinking, context, reasoning) and `variants` (param combinations).
- The extension expands these into **208 registered OMP model ids** via
  `getCursorModelSelectionIdentities()`:
  - base id: `grok-4.6`
  - context variants: `gpt-5.6-sol@272k`, `@1m`
  - fast variants: `grok-4.6@fast`, `grok-4.6@slow`
  - aliases: `gpt-5-6-sol`, `gpt-latest`, `kimi`, `composer-2-5`, ...
- The catalog is cached at `~/.omp/agent/cursor-sdk-model-list.json`,
  keyed by `sha256(apiKey)[:16]` (the key itself is never stored), with a
  24h TTL. `/cursor-refresh-models` bypasses the cache.
- The model list is **not** hand-maintained in `models.yml` — it comes from
  Cursor's live catalog, so new Cursor models appear after a refresh.

### 3.3 Context windows

Cursor's catalog publishes **no context window** for any model. The
extension resolves context from, in order:

1. `~/.omp/agent/cursor-sdk-context-windows.json` — user overrides
   (also written automatically from real SDK run checkpoints:
   `checkpoint.tokenDetails.maxTokens`).
2. The bundled map in `src/bundled-context-windows.ts` (known models such
   as `grok-4.5: 256000`).
3. The `"default"` entry (`200000`).

Example (measured from a real grok-4.6 run):

```json
{ "contextWindows": { "gpt-5-6-sol@272k": 272000, "grok-4.6@fast": 256000 } }
```

## 4. Authentication and key resolution

Cursor Dashboard API key (`crsr_...`), stored in `~/.omp/.env` as
`CURSOR_API_KEY`.

### 4.1 Key precedence (turn time)

```
options.apiKey (from OMP's registry)  ->  resolveCursorStringApiKey()
    -> only literal strings; ApiKeyResolver values are never forwarded
agent.db stored credential (provider "cursor")  ->  SqliteAuthCredentialStore.getApiKey("cursor")
process.env.CURSOR_API_KEY   (OMP auto-loads ~/.omp/.env at module init)
```

Implementation: `resolveCursorApiKey()` normalizes placeholders
(`$CURSOR_API_KEY`, `${CURSOR_API_KEY}`, the provider-config sentinel) to the
env value; `resolveCursorStringApiKey()` gates OMP's `ApiKey` type
(`string | ApiKeyResolver`) to strings before the Cursor SDK sees it.

### 4.2 The registration placeholder

`registerProvider` uses a non-empty placeholder
(`pi-cursor-sdk-cursor-api-key-placeholder`) so the provider registers even
before auth exists. The real key is resolved at discovery and turn time.
OMP's registry stores the placeholder; resolution happens through the
extension's own key path.

### 4.3 Stored credential

At load, the extension persists the resolved env key into OMP's credential
store (`SqliteAuthCredentialStore` on `~/.omp/agent/agent.db`, table
`auth_credentials`, provider `cursor`, type `api_key`) via
`ensureStoredCursorApiKey()` — never overwriting an existing credential.
This matters for OMP's availability model, see §8.1.

## 5. The turn path

When OMP needs a model turn for a `cursor/*` model, it calls the
provider's `streamSimple`:

```
streamCursor(model, context, options)
  -> createAssistantMessageEventStream()
  -> CursorProviderTurnRunner.run()
       -> prepare: buildCursorModelSelection(model.id, reasoning, fastEnabled)
            -> maps OMP's --thinking level through the model's thinkingLevelMap
               to the SDK's effort/reasoning/thinking param
            -> fastEnabled from the model's fast override (@fast/@slow) or
               --cursor-fast/--cursor-no-fast or the model default
       -> load @cursor/sdk, Agent.create({ apiKey, model: selection, mode, local })
            -> local agent loop (session, tools, thinking) runs on the machine
       -> agent.send(payload, { mode, model, onDelta, onStep })
       -> run.wait()  ->  RunResult
       -> usage accounting applied to the assistant message
  -> stream events pushed back to OMP (start / text deltas / done | error)
```

### 5.1 Runtime selection

- **Local (default):** the SDK agent loop runs locally; models are served by
  Cursor's backend with the key.
- **Cloud (opt-in):** set `PI_CURSOR_RUNTIME=cloud` plus the ack/config env
  vars (`PI_CURSOR_CLOUD_ACK`, `PI_CURSOR_CLOUD_REPO`, ...). Cloud agents
  run in Cursor-hosted VMs.

### 5.2 Error handling and overflow normalization

- SDK errors are sanitized by `sanitizeCursorProviderError()` (scrubs the
  key from messages, classifies auth/network/rate-limit).
- **Context-overflow normalization:** OMP auto-compacts on
  `context_length_exceeded`. Pi rewrote overflow failures via the
  `message_end` event; OMP's `message_end` handler cannot return a
  replacement message, so the rewrite runs in the provider's terminal-error
  path (`pushTerminalError`) instead.
- `ApiKey` values that are resolvers are never stringified into requests.

### 5.3 Usage accounting

Per-run SDK `TokenUsage` (input/output/cacheRead/cacheWrite/totalTokens) is
applied to the assistant message so OMP's dashboard and `stats.db` see
real usage. Context-window budget math null-guards OMP's `Model` fields
(`contextWindow`/`maxTokens` are nullable in OMP).

## 6. Session lifecycle integration

The extension wires into OMP's session events:

- **session scope:** cwd/session-file tracking via `session_start`
  (OMP's event carries no project-trust or session-info payload — Pi's
  `project_trust` and `session_info_changed` events do not exist in OMP).
- **agent pooling & resume:** session-scoped Cursor SDK agents are pooled
  and resumed across turns within a session.
- **skill catalog:** Cursor's local loop gets OMP's active skills via
  `getActiveSkills()` (Pi's `before_agent_start.systemPromptOptions.skills`
  does not exist in OMP); hidden skills (`Skill.hide`) are filtered like
  Pi filtered `disableModelInvocation`.
- **tool bridge:** an MCP bridge can expose OMP tools to the Cursor agent.
- **native tool display:** the port registers only the self-contained
  `cursor_replay_activity` tool. Pi shadowed the builtin
  read/bash/edit/write/grep/find/ls tools to render Cursor-native activity;
  OMP exposes no wrapped builtin definition to delegate execution to, so
  builtin shadowing is **not portable** and those names are never
  registered (registering one throws "Unsupported Cursor native replay
  tool" — fixed by filtering to replay-only names).

## 7. OMP API surfaces the port adapted

Verified drift table (OMP 17.3.0 vs Pi 0.84):

| Surface | Pi 0.84 | OMP 17.3.0 | Port action |
|---|---|---|---|
| imports | `@earendil-works/pi-*` | `@oh-my-pi/pi-*` | remapped |
| tool schemas | `typebox` | `@oh-my-pi/omptype/typebox` (OMP's legacy shim) | import swap |
| `getSystemPrompt()` | string | `string[]` | `.join("\n")` |
| `BeforeAgentStartEvent.systemPrompt` | string | `string[]` | join; result `systemPrompt: string[]` |
| `BeforeAgentStartEvent.systemPromptOptions` | present | absent | source skills from `getActiveSkills()` |
| `ctx.getSystemPrompt()` | string | `string[]` | join |
| `ctx.mode` / `isProjectTrusted` / `signal` | present | absent | drop / AbortController / `hasUI` |
| `SessionShutdownEvent.reason` | present | absent | always dispose |
| `model_select` event | present | absent | not registered (handlers inert) |
| `project_trust` / `session_info_changed` | present | absent | dropped |
| `message_end` result rewrite | supported | not supported | moved into provider error path |
| `ToolDefinition` fields | `promptSnippet`, `promptGuidelines`, `executionMode` | not present | removed |
| `renderCall` / `renderResult` | `(args, theme, context)` | `(args, options, theme)` / `(result, options, theme, args?)` | signature swap; `fg`/`bold` via Theme |
| `Skill.disableModelInvocation` | present | absent | filter on `Skill.hide` |
| thinking levels | `ModelThinkingLevel`/`ThinkingLevelMap` | absent from pi-ai | vendored locally (`minimal..max` + `off`; `Effort` has no `off`) |
| `CONFIG_DIR_NAME` | pi-coding-agent | `@oh-my-pi/pi-utils` | import moved (value `.omp`) |
| `readStoredCredential` | shim export | absent | `SqliteAuthCredentialStore` |
| `create*ToolDefinition` | root exports | absent | not used (shadowing dropped) |
| config paths | `~/.pi` | `~/.omp` | automatic via pi-utils |

## 8. OMP-side behaviors and limitations

### 8.1 The `/model` picker does not list cursor models

OMP's model registry filters "available" models to providers that are
**config-configured** (`models.yml`) **or carry stored auth**
(`authStorage.hasAuth`). Verified mechanics:

- `hasAuth(provider)` reads an **in-memory cache** (`#data`), populated by
  `reload()`; it is not a live DB read.
- `getEnvApiKey(provider)` only knows OMP's own provider map
  (`serviceProviderMap`); `cursor` is not in it, so an env key alone never
  makes the provider available.
- The extension cannot reach OMP's `AuthStorage` instance at load
  (ExtensionAPI has no authStorage/modelRegistry), and cannot write the
  config set (`#c`).

Consequences:

- `--model cursor/...` **works** (CLI resolution uses the full model set).
- `/model` picker and `/model <id>` only see available models → cursor is
  absent; `/model cursor/grok-4.6@slow` returns "Unknown model".
- A `cursor:` block in `models.yml` is **actively harmful**: it shadows the
  extension's `api: "cursor-sdk"` transport with an `openai-completions`
  config and breaks every turn with an API-key-exchange error. Do not add it.

Workarounds: launch with `--model cursor/...`, or set the default in
`~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: cursor/grok-4.6@slow:high
```

The real fix (making auth-resolvable extension providers visible in the
picker) is an OMP core change, not a plugin change.

### 8.2 The `:fast`/`:slow` id collision

OMP's model-id grammar treats `model:level` as thinking-level syntax
(`opencode-go/deepseek-v4-flash:xhigh`). Pi's `:fast`/`:slow` suffix was
normalized away at registration and could never be selected. The port
renamed the suffix to `@fast`/`@slow` (OMP treats `@` literally, proven by
the `@context` variants). Select fast variants as
`cursor/grok-4.6@fast --thinking high`.

### 8.3 Backend flakiness

Cursor's backend intermittently returns gRPC `UNAUTHENTICATED`
("Connect error unauthenticated: Error") for some grok requests through the
SDK path, even when the identical key/params succeed standalone and in
other runs. It is non-deterministic and backend-side; retry or use the
`@fast` variant (observed reliable).

### 8.4 Priced variants

Cursor's pricing distinguishes standard and Fast variants (Grok 4.6:
$2/$0.50/$6 per M standard, $4/$1/$12 Fast; 50% launch discount from
2026-08-12). The plain base id defaults to the model's default variant
(fast:true for grok-4.6), so to guarantee standard pricing use the explicit
`@slow` id. Fast is a speed tier, not a different model — `--thinking`
controls reasoning depth on both variants.

## 9. Operation reference

### Slash commands (in-session)

- `/cursor-refresh-models` — refresh the live catalog (bypasses cache)
- `/cursor-fast` — toggle fast mode for the current cursor model
- `/cursor-tools` — live tool-surface debug report
- `/cursor-mode <agent|plan>` — agent/plan mode

### Flags

- `--cursor-fast` / `--cursor-no-fast` — force fast mode on/off
- `--cursor-mode <agent|plan>` — CLI mode override
- `--thinking <level>` — maps to the SDK effort/reasoning param
  (off/minimal/low/medium/high/xhigh/max/auto)

### Environment

- `CURSOR_API_KEY` — API key (`.env` auto-loaded by OMP)
- `PI_CURSOR_RUNTIME=cloud` — opt into cloud agents
- `PI_CURSOR_CLOUD_ACK=1` (+ `PI_CURSOR_CLOUD_REPO`, ...) — cloud ack/config
- `PI_CURSOR_FAST_DEFAULTS`-class vars — fast defaults per model
- `PI_CURSOR_SDK_EVENT_DEBUG=1` — SDK event debug logging

### Files

- `~/.omp/agent/cursor-sdk-model-list.json` — model catalog cache (fingerprint-keyed)
- `~/.omp/agent/cursor-sdk-context-windows.json` — context-window overrides
  (user-editable)
- `~/.omp/agent/agent.db` — OMP credential store (provider `cursor` row)
- `~/.omp/agent/models.yml` — must NOT contain a `cursor:` block (§8.1)

### Verification

- `omp --model cursor/composer-2.5 --no-session --mode text "hi"` — smoke turn
- `omp --model cursor/grok-4.6@fast --thinking high ...` — variant turn
- `omp plugin list` — plugin enabled
- `npx tsc --noEmit` in the fork — typecheck against OMP 17.3.0 types
- `bun -e 'import("./src/index.ts").then(m=>console.log(typeof m.default==="function"))'`
  — load-under-Bun proof (mirrors OMP's loader)
