# ai-sdk-provider-dsh

[AI SDK](https://ai-sdk.dev) provider that drives a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) runtime as a language model.

`dsh` is a full agent harness (agent loop, tools, skills, MCP, sessions) from DeepSeek AI. This provider wraps a `dsh` runtime subprocess behind the AI SDK `LanguageModel` interface, so you can drive a harness agent from AI SDK `generateText` / `streamText` the same way `ai-sdk-provider-claude-code` drives Claude Code — while keeping the AI SDK as the single orchestration surface.

## Version Compatibility

This provider implements the **`LanguageModelV3`** specification (`specificationVersion: 'v3'`), the interface shared across AI SDK majors. A single build serves both:

| AI SDK | `@ai-sdk/provider` | Status |
| ------ | ------------------ | ------ |
| `ai@^6` | `@ai-sdk/provider@^3` | ✅ supported |
| `ai@^7` | `@ai-sdk/provider@^4` | ✅ supported (V3 models are first-class in v7) |

| Requirement | Value |
| ----------- | ----- |
| Node.js | `>=22.19` |
| Module format | ESM only |
| DeepSeek Harness family | pinned exact `0.1.0-rc.6` |

> **Upstream status:** `dsh` is in developer preview (`0.1.0-rc.x`); DeepSeek documents breaking changes as their release policy. This provider pins the harness SDK family to exact versions, so the runtime version is a deliberate platform-side decision — upgrade the pin explicitly, never by range drift.

## Install

```sh
npm install ai-sdk-provider-dsh
```

The `dsh` runtime is **bundled**: the package ships a default runtime composition (`runtime/cordis.yml`) plus the `dsh-jsonrpc-agent` bin (via `@deepseek-ai/dsh-sdk-jsonrpc-demo`), and all runtime plugins are pinned exact versions in `dependencies`. A provider instance spawns a working runtime out of the box — no separate install.

Credentials come from the runtime's environment:

```sh
export DEEPSEEK_API_KEY=sk-...                                        # required
export DEEPSEEK_BASE_URL=https://api.deepseek.com                     # optional; any OpenAI-compatible gateway works
```

## Quick Start

### `streamText` (AI SDK v7)

```typescript
import { streamText } from "ai";
import { createDsh } from "ai-sdk-provider-dsh";

const dsh = createDsh({
  runtime: { provider: "deepseek-official", model: "deepseek-v4-flash" },
});

const result = streamText({
  model: dsh.languageModel("deepseek-v4-flash"),
  instructions: "You are a coding agent.",
  prompt: "run the tests",
});

const text = await result.text;
console.log(text);
```

### `streamText` (AI SDK v6)

```typescript
import { streamText } from "ai";
import { createDsh } from "ai-sdk-provider-dsh";

const dsh = createDsh({ runtime: { provider: "deepseek-official", model: "deepseek-v4-flash" } });

const result = streamText({
  model: dsh.languageModel("deepseek-v4-flash"),
  system: "You are a coding agent.", // v6 name; v7 uses `instructions`
  prompt: "run the tests",
});
```

### `generateText`

```typescript
import { generateText } from "ai";
import { createDsh } from "ai-sdk-provider-dsh";

const dsh = createDsh({ runtime: { provider: "deepseek-official", model: "deepseek-v4-flash" } });
const { text } = await generateText({
  model: dsh.languageModel("deepseek-v4-flash"),
  prompt: "say hello",
});
```

### Provider factory

```typescript
const dsh = createDsh(options);        // returns the provider
dsh.languageModel("deepseek-v4-flash") // the LanguageModel
dsh("deepseek-v4-flash")               // callable alias (AI SDK provider convention)
await dsh.close();                     // tear down the runtime subprocess (idempotent)
```

## Runtime Options

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `provider` | required | model provider route passed to the runtime handshake (`deepseek-official`, or a pi-ai catalog route) |
| `model` | required | model id passed to the runtime handshake |
| `env` | inherits `process.env` | environment for the runtime subprocess: credentials (`DEEPSEEK_API_KEY`), `DEEPSEEK_BASE_URL`, `DSH_CWD`, `DSH_SESSION_ROOT`, … |
| `cwd` | `process.cwd()` | subprocess working directory |
| `configPath` | bundled `runtime/cordis.yml` | a different cordis.yml composition |
| `binPath` | bundled `dsh-jsonrpc-agent` | a different runtime bin |
| `command` / `args` | `node` + `[bin, config]` | full custom launch vector (set both together) |
| `maxTokens` | — | positive output-token cap per root-agent request |
| `requestTimeoutMs` | SDK default | per-request timeout for the JSON-RPC transport |
| `disposeEofGraceMs` / `disposeGraceMs` | SDK defaults | subprocess teardown ladders (EOF → SIGTERM → SIGKILL) |
| `sessionId` | fresh UUID | fixed session id; keep it to continue one harness session across turns |

### The bundled runtime

The default composition (`runtime/cordis.yml`) exposes:

- **bash** (foreground), **read/write/edit** (fs), **subagent**, **todo_write** — tools execute inside the harness
- JSONL session persistence with automatic context compaction
- `$DSH_SYSTEM_PROMPT` selects the deployment persona

For environments that cannot build `node-pty` (no Linux prebuild — e.g. minimal containers, WSL without libc6-dev), use the no-pty composition:

```typescript
runtime: {
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  configPath: require.resolve("ai-sdk-provider-dsh/runtime/cordis.minimal.yml"),
}
```

## How it works

- Each provider instance spawns (lazily) one `dsh` runtime subprocess speaking stdio JSON-RPC (the [dsh SDK protocol](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/sdk/protocol)).
- `doGenerate` / `doStream` translate AI SDK `LanguageModelV3CallOptions` into a dsh prompt, then map the runtime's `session.event` stream back into AI SDK stream parts (`text-start/delta/end`, `reasoning-start/delta/end`, `tool-input-start/delta/end`, `tool-call`, `finish`).
- **Tools execute inside the harness** — the provider is a thin pass-through (like `ai-sdk-provider-claude-code`): tool calls surface as `providerExecuted: true` parts and the AI SDK never re-executes them.
- **Multi-turn sessions**: one provider instance keeps one runtime subprocess; with a fixed `sessionId`, follow-up turns continue the same harness session (the runtime persists the session log). Verified end-to-end: turn 1 stores a secret code, turn 2 recalls it.
- **Abort**: an aborted call surfaces the original abort reason (never a wrapped transport error); pre-aborted signals throw immediately; the abort listener is removed on completion.

## Provider Metadata

Each response exposes dsh metadata under `providerMetadata['dsh']` (AI SDK v7: `result.finalStep.providerMetadata`, or `await stream.finalStep` for `streamText`; v6: `result.providerMetadata`):

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `sessionId` | `string` | the harness session id this call ran on |
| `turnId` | `number?` | last observed turn number |
| `terminalReason` | `string?` | final turn end kind when not `completed` (`aborted`, `error`, `max-tokens`, `blocked`, `interrupted`) |

## Error Diagnostics

Errors from the runtime boundary are classified into AI SDK `APICallError`s. A sanitized stderr tail is appended to the message so CLI failures are visible in logs:

```
dsh runtime subprocess failed: runtime exited | stderr (tail): ...; ...
```

```typescript
import { generateText } from "ai";
import { createDsh, getErrorMetadata, isAPICallError } from "ai-sdk-provider-dsh";

try {
  await generateText({ model: dsh.languageModel("deepseek-v4-flash"), prompt: "Hello!" });
} catch (error) {
  if (isAPICallError(error)) {
    console.error(getErrorMetadata(error)?.stderr);
    console.error("retryable:", error.isRetryable);
  }
}
```

Classification map:

| Runtime failure | AI SDK error | Retryable |
| --------------- | ------------ | --------- |
| `TransportClosedError` (subprocess died / stdio closed) | `APICallError` | ✅ |
| `RequestTimeoutError` | `APICallError` | ✅ |
| `SdkProtocolError` (wire violation) | `APICallError` | ❌ |
| `JsonRpcResponseError` (runtime rejected request) | `APICallError` | ❌ |
| Node spawn failure (`ENOENT` bin, …) | `APICallError` | only `EAGAIN`/`EMFILE` |
| Missing/invalid API key | `LoadAPIKeyError` (via `createAuthenticationError`) | — |

## Limitations

- Requires Node.js `>=22.19`; ESM only.
- **No mid-turn cancel on the SDK wire**: aborting a turn rejects the current call; the runtime subprocess and session log remain for follow-up turns. `dsh.close()` tears the subprocess down (EOF → SIGTERM → SIGKILL).
- **Skills use the dsh native mechanism** (`SKILL.md` bundles discovered from `.dsh/skills`, `.agents/skills`, `$DSH_HOME/skills`) — the reskill `skills.json`/`skills.lock` convention is not applied by this provider.
- **Tool execution is harness-internal**: AI SDK `tools` / `toolChoice` are not executed by the AI SDK; configure tools through the runtime composition (cordis.yml) or `$DSH_*` env.
- Some AI SDK call options are accepted but not forwarded to the harness: `temperature`, `topP`, `topK`, `stopSequences`, `seed` — the harness owns sampling.
- **`dsh` is in developer preview**; DeepSeek documents breaking changes as release policy. Pin the provider version and the harness family (`0.1.0-rc.6`) deliberately.
- The bundled default runtime needs `node-pty` on Linux (compiled at install; no prebuild). Use `cordis.minimal.yml` (no bash) where that is unavailable.

## Development

```sh
pnpm install
pnpm run check    # typecheck
pnpm run test     # unit tests (fake runtime) + e2e (real runtime, keyless replay)
pnpm run lint     # biome
pnpm run build    # tsup → dist/
```

Tests never need a real API key: unit tests drive a fake runtime with synthetic event streams (the `ai-sdk-provider-claude-code` philosophy), and e2e tests boot the real `dsh` runtime against **recorded session fixtures** replayed by `@deepseek-ai/dsh-llm-replay`.

### Recording new fixtures (requires a live key)

```sh
DEEPSEEK_API_KEY=sk-... node scripts/record-fixture.mjs   # writes tests/fixtures/*.jsonl
```

## License

MIT
