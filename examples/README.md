# Examples

Curated examples for the most important `ai-sdk-provider-dsh` patterns. Each
example is runnable with `npx tsx examples/<name>.ts` (requires
`DEEPSEEK_API_KEY` in the environment — see the root README).

## Prerequisites

```bash
pnpm install
pnpm run build          # build dist/ (examples import from ../src via tsx)
export DEEPSEEK_API_KEY=sk-...
```

> The examples import from `../src/index.js` so they always run against the
> current source; the published package consumers use `dist/`.

## Quick Reference

| # | Example | Purpose | Key concepts |
|---|---------|---------|--------------|
| 1 | `basic-usage.ts` | Simplest possible `generateText` | token usage, `providerMetadata['dsh']`, error metadata |
| 2 | `streaming.ts` | Real-time `streamText` | `text-delta` / `reasoning-delta` / `tool-call` / `finish` parts |
| 3 | `multi-turn.ts` | Session continuity across calls | fixed `sessionId`, harness session log |
| 4 | `custom-config.ts` | Runtime composition overrides | `configPath` (no-pty minimal), `DSH_CWD`, `DSH_SESSION_ROOT` |
| 5 | `abort.ts` | Cancelling a stream mid-flight | `AbortController`, original abort reason preserved |

## Learning path

1. Start with **basic-usage** — the shape of a result and where dsh metadata lives.
2. Move to **streaming** — observe how reasoning, text, and tool parts arrive live.
3. Try **multi-turn** — prove the harness session remembers across turns.
4. Skim **custom-config** — how to swap the runtime composition for your deployment.
5. Read **abort** — how cancellation behaves when you need to stop a long run.
