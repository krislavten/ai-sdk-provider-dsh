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

## Install

```sh
npm install ai-sdk-provider-dsh
```

The `dsh` runtime is **not** bundled. You provide a runtime entry that composes the [dsh SDK jsonrpc server](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/sdk/server) (see [examples/runtime](examples/runtime) for a ready-made one).

## Usage

```ts
import { createDsh } from "ai-sdk-provider-dsh";

const dsh = createDsh({
  // command/args that spawn a harness runtime with the dsh jsonrpc server plugin
  launch: { command: "node", args: ["./dsh-runtime/bin.js", "cordis.yml"] },
  provider: "deepseek-official",
  model: "deepseek-v4-flash",
  // optional: DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL env for the runtime subprocess
});

const result = await generateText({
  model: dsh("deepseek-v4-flash"),
  prompt: "run the tests",
});
```

## How it works

- Each `createDsh` instance spawns (lazily) one `dsh` runtime subprocess speaking stdio JSON-RPC (the [dsh SDK protocol](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/sdk/protocol)).
- `doGenerate` / `doStream` translate AI SDK `LanguageModelV3CallOptions` into a dsh prompt, then map the runtime's `session.event` stream back into AI SDK stream parts (`text-delta`, `tool-call`, `tool-result`, finish).
- Tool execution happens **inside the harness** (dsh owns the agent loop and tools), like Claude Code providers. `getTools()` returns `undefined`.

## License

MIT
