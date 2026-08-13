# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-14

### Added

- **Error classification** (`src/errors.ts`): transport failures
  (`TransportClosedError`, `RequestTimeoutError`, `SdkProtocolError`,
  `JsonRpcResponseError`, spawn errors) normalize to AI SDK `APICallError`
  with retryability, sanitized stderr tail, and prompt excerpt; exported
  `classifyDshError`, `isAPICallError`, `getErrorMetadata`, `stderrTail`,
  `createAPICallError`, `createAuthenticationError`.
- **Fail-fast credential check**: `DshRuntime` throws a clear
  `DshCredentialError` (mapped to `LoadAPIKeyError`) when
  `deepseek-official` is selected without `DEEPSEEK_API_KEY`, instead of
  silently producing empty output. Exempts replay mode (`DSH_SNAPSHOT_FILE`).
- **Abort preservation**: pre-aborted signals throw immediately; mid-run
  aborts surface the original abort reason (never a wrapped transport
  error); abort listeners are removed on completion.
- **`providerMetadata['dsh']`**: `sessionId`, `turnId`, `terminalReason`
  on every result.
- **Keyless CI testing**: recorded session fixtures
  (`tests/fixtures/text-turn.jsonl`, `multi-turn.jsonl`) replayed by
  `@deepseek-ai/dsh-llm-replay` (`runtime/cordis.replay.yml`); recorder at
  `scripts/record-fixture.mjs`.
- **Mock-boundary unit tests**: `DshRuntimeLike` interface lets tests drive
  `doStream`/`doGenerate` with a fake runtime — no subprocess, no network.
- **Examples** (`examples/`): basic-usage, streaming, multi-turn,
  custom-config, abort + README.
- **Documentation**: README rewritten with version-compatibility matrix,
  per-major quick starts, runtime options table, providerMetadata table,
  error diagnostics, honest limitations, development guide.

### Fixed

- **Text duplication in streamed output**: the runtime streams
  `text-delta` chunks AND a final `block-end` carrying the full text;
  mapping both produced duplicated output. `block-end` now emits full text
  only when no delta was streamed, plus `tool-input-start/end` framing
  around tool-call deltas. (Found via live DeepSeek API verification.)
- **`args` silently replacing the default `[bin, config]` vector**:
  `DshRuntimeOptions` gained `configPath`/`binPath` overrides; `args` is
  now a full custom vector documented as such.

### Changed

- `runtime/` ships `cordis.yml` (default, with bash) and
  `cordis.minimal.yml` (no node-pty) and `cordis.replay.yml` (keyless CI).
- CI runs the dual-major matrix (`ai@6`/`provider@3` and
  `ai@7`/`provider@4`) with unit + replay e2e tests; release publishes via
  OIDC trusted publishing.

## [0.1.2] - 2026-08-13

### Fixed

- `repository` field added for npm provenance validation (OIDC publish).

## [0.1.1] - 2026-08-13

### Changed

- Bundled default dsh runtime (full plugin closure pinned `0.1.0-rc.6`),
  `configPath`/`binPath` runtime options, no-pty minimal composition,
  `./runtime/*` subpath export.

## [0.1.0] - 2026-08-13

### Added

- Initial release: `createDsh` provider factory, `LanguageModelV3`
  implementation (AI SDK v6 + v7), dsh runtime subprocess management,
  event mapping, bundled runtime composition.
