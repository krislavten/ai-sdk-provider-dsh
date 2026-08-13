# ai-sdk-provider-dsh

[AI SDK](https://ai-sdk.dev) provider that drives a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) runtime as a language model.

`dsh` is a full agent harness (agent loop, tools, skills, MCP, sessions) — this provider wraps a `dsh` runtime subprocess behind the AI SDK `LanguageModel` interface, so you can drive a harness agent from AI SDK `generateText` / `streamText` the same way `ai-sdk-provider-claude-code` drives Claude Code.

## Compatibility

Implements the **`LanguageModelV3`** specification (`specificationVersion: 'v3'`), which is the shared interface across AI SDK majors:

| AI SDK | `@ai-sdk/provider` | Status |
|---|---|---|
| `ai@^6` | `@ai-sdk/provider@^3` | ✅ supported |
| `ai@^7` | `@ai-sdk/provider@^4` | ✅ supported (V3 models are first-class in v7) |

- Node.js `>=22.19`
- ESM only
- Pins the DeepSeek Harness SDK family to `0.1.0-rc.6`

## Install

```sh
npm install ai-sdk-provider-dsh
```

The `dsh` runtime is **bundled**: the package ships a default runtime composition (`runtime/cordis.yml`) and the `dsh-jsonrpc-agent` bin (via `@deepseek-ai/dsh-sdk-jsonrpc-demo`), so a provider instance spawns a working runtime out of the box. All runtime plugins are pinned exact versions in `dependencies`.

## Usage

```ts
import { generateText, streamText } from "ai";
import { createDsh } from "ai-sdk-provider-dsh";

const dsh = createDsh({
  runtime: {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    // credentials for the runtime subprocess:
    env: {
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      // DEEPSEEK_BASE_URL: optional OpenAI-compatible gateway override
    },
  },
});

// streamText (v6: `system` / v7: `instructions`)
const result = streamText({
  model: dsh.languageModel("deepseek-v4-flash"),
  system: "You are a coding agent.",
  prompt: "run the tests",
});
```

### Runtime options

| Option | Default | Meaning |
|---|---|---|
| `provider` / `model` | required | model route passed to the runtime handshake |
| `env` | inherits `process.env` | env for the runtime subprocess (credentials, `DSH_CWD`, `DSH_SESSION_ROOT`, …) |
| `cwd` | `process.cwd()` | subprocess working directory |
| `configPath` | bundled `runtime/cordis.yml` | a different cordis.yml composition |
| `binPath` | bundled `dsh-jsonrpc-agent` | a different runtime bin |
| `command` / `args` | `node` + `[bin, config]` | full custom launch vector (both required if overridden) |
| `maxTokens` | — | positive output-token cap per root-agent request |
| `sessionId` | fresh UUID | fixed session id; keep it to continue one harness session across turns |

The bundled default composition exposes bash (foreground), read/write/edit, subagent, and todo tools. For environments that cannot build `node-pty` (no Linux prebuild), use the no-pty minimal composition shipped as `runtime/cordis.minimal.yml`:

```ts
runtime: {
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  configPath: require.resolve("ai-sdk-provider-dsh/runtime/cordis.minimal.yml"),
}
```

## How it works

- Each provider instance spawns (lazily) one `dsh` runtime subprocess speaking stdio JSON-RPC (the [dsh SDK protocol](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/sdk/protocol)).
- `doGenerate` / `doStream` translate AI SDK `LanguageModelV3CallOptions` into a dsh prompt, then map the runtime's `session.event` stream back into AI SDK stream parts (`text-delta`, `tool-input-*`, `tool-call`, `finish`).
- Tool execution happens **inside the harness** (dsh owns the agent loop and tools), like Claude Code providers — the provider is a thin pass-through.
- There is no mid-turn cancel on the SDK wire: aborting a turn means closing the runtime (`close()`); the runtime's append-only session log survives restarts for follow-up turns.

## License

MIT
