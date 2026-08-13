/**
 * Manages the dsh runtime subprocess lifecycle for one provider instance.
 *
 * One `DeepSeekHarness` owns one runtime subprocess (spawned lazily on first
 * use, kept alive across turns, torn down on `close`). A provider instance
 * reuses the same session id across turns so follow-up turns continue the
 * same harness session (the runtime persists the session log).
 *
 * NOTE on type isolation: this module's public surface intentionally does
 * NOT reference `@deepseek-ai/dsh-sdk-client` types. The SDK is a runtime
 * `dependency` (spawned subprocess + wire protocol), but its type graph is
 * large and version-coupled; exposing it in our `.d.ts` would force
 * consumers to resolve the whole dsh type closure. We narrow to a minimal
 * structural notification type at the boundary instead.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";

/**
 * Minimal structural view of a wire notification. Compatible with the SDK's
 * `HarnessNotification` (`{ method: string; params: Record<string, unknown> }`)
 * without importing its type.
 */
export interface DshNotification {
	method: string;
	params: Record<string, unknown>;
}

export interface DshRuntimeOptions {
	/**
	 * Command that spawns a dsh harness runtime speaking the stdio JSON-RPC
	 * SDK protocol. Defaults to `process.execPath` running the bundled
	 * `@deepseek-ai/dsh-sdk-jsonrpc-demo` bin (`dsh-jsonrpc-agent`) with the
	 * provider's default `runtime/cordis.yml` composition.
	 */
	command?: string;
	/**
	 * Full argument vector for the runtime command. When omitted, the default
	 * is `[binPath, configPath]` — the bundled `dsh-jsonrpc-agent` bin plus a
	 * cordis.yml. If you set `command` you normally must set `args` too.
	 */
	args?: string[];
	/**
	 * Override the cordis.yml passed to the bundled runtime bin (the default
	 * args become `[bin, this]`). Ignored when `args` is set explicitly.
	 */
	configPath?: string;
	/**
	 * Override the dsh runtime bin (the default args become `[this, config]`).
	 * Ignored when `args` is set explicitly.
	 */
	binPath?: string;
	/**
	 * Working directory for the runtime subprocess and its tools. Defaults to
	 * the caller's `cwd` option (or the provider's launch cwd).
	 */
	cwd?: string;
	/** Environment for the runtime subprocess (credentials, DSH_* vars). Inherits `process.env` when omitted. */
	env?: NodeJS.ProcessEnv;
	/** Model provider route passed to the runtime handshake. */
	provider: string;
	/** Model id passed to the runtime handshake. */
	model: string;
	/** Positive output-token cap per root-agent request. */
	maxTokens?: number;
	/** Per-request timeout for the JSON-RPC transport. */
	requestTimeoutMs?: number;
	/** Grace (ms) for cooperative stdin-EOF shutdown before SIGTERM. */
	disposeEofGraceMs?: number;
	/** Grace (ms) for SIGTERM before SIGKILL. */
	disposeGraceMs?: number;
	/** Fixed session id; default is a fresh UUID per provider instance. */
	sessionId?: string;
}

/**
 * Resolve the bundled default runtime: the `dsh-jsonrpc-agent` bin and the
 * provider's own `runtime/cordis.yml`. Works from both `src/` (dev) and
 * `dist/` (packaged) layouts.
 */
function bundledRuntime(): { command: string; args: string[] } {
	const require = createRequire(import.meta.url);
	const demoPackageJson = require.resolve(
		"@deepseek-ai/dsh-sdk-jsonrpc-demo/package.json",
	);
	const binPath = join(dirname(demoPackageJson), "lib", "bin.js");

	const here = dirname(fileURLToPath(import.meta.url));
	// dist/ layout: tsup publicDir copies runtime/cordis.yml → dist/cordis.yml
	const distConfig = join(here, "cordis.yml");
	// src/ layout: runtime/cordis.yml sits next to src/
	const srcConfig = join(here, "..", "runtime", "cordis.yml");
	const configPath = existsSync(distConfig) ? distConfig : srcConfig;

	return { command: process.execPath, args: [binPath, configPath] };
}

/**
 * The runtime surface the LanguageModel depends on. Kept as an interface so
 * unit tests can inject a fake (no subprocess); `DshRuntime` is the real
 * implementation.
 */
export interface DshRuntimeLike {
	readonly sessionId: string;
	run(
		input: string,
		onNotification: (notification: DshNotification) => void,
	): Promise<{ events: unknown[]; finalResponse: string }>;
	close(): Promise<void>;
}

export class DshRuntime implements DshRuntimeLike {
	private harness: DeepSeekHarness | undefined;
	private closed = false;
	readonly sessionId: string;

	constructor(private readonly options: DshRuntimeOptions) {
		this.sessionId = options.sessionId ?? crypto.randomUUID();
		this.assertCredentialPresent();
	}

	/**
	 * Fail fast with a clear authentication error when the runtime would have
	 * no way to call the model. The runtime reads credentials from its own
	 * env (explicit `env` option or inherited `process.env`); the
	 * `deepseek-official` route requires `DEEPSEEK_API_KEY`. If you provide
	 * keys through `$DSH_HOME/.credentials.yaml` instead, pass a dummy
	 * `DEEPSEEK_API_KEY` in `env` (or set `DSH_HOME`) to satisfy the check.
	 */
	private assertCredentialPresent(): void {
		const effectiveEnv = this.options.env ?? process.env;
		// Replay mode (DSH_SNAPSHOT_FILE set) replaces the LLM adapter with
		// @deepseek-ai/dsh-llm-replay — no credential needed.
		if (effectiveEnv.DSH_SNAPSHOT_FILE) return;
		if (
			this.options.provider === "deepseek-official" &&
			!effectiveEnv.DEEPSEEK_API_KEY
		) {
			const error = new Error(
				"dsh runtime: DEEPSEEK_API_KEY is required for provider 'deepseek-official'. " +
					"Set it in the runtime `env` option or export it in the environment. " +
					"(If you use $DSH_HOME/.credentials.yaml, pass a dummy DEEPSEEK_API_KEY in env.)",
			);
			error.name = "DshCredentialError";
			throw error;
		}
	}

	private getHarness(): DeepSeekHarness {
		if (this.closed) {
			throw new Error("dsh runtime has been closed");
		}
		if (this.harness === undefined) {
			const bundled = bundledRuntime();
			const args = this.options.args ?? [
				this.options.binPath ?? bundled.args[0],
				this.options.configPath ?? bundled.args[1],
			];
			this.harness = new DeepSeekHarness({
				launch: {
					command: this.options.command ?? bundled.command,
					args,
					cwd: this.options.cwd,
					env: this.options.env,
					...(this.options.requestTimeoutMs !== undefined
						? { requestTimeoutMs: this.options.requestTimeoutMs }
						: {}),
					...(this.options.disposeEofGraceMs !== undefined
						? { disposeEofGraceMs: this.options.disposeEofGraceMs }
						: {}),
					...(this.options.disposeGraceMs !== undefined
						? { disposeGraceMs: this.options.disposeGraceMs }
						: {}),
				},
				cwd: this.options.cwd,
				provider: this.options.provider,
				model: this.options.model,
				...(this.options.maxTokens !== undefined
					? { maxTokens: this.options.maxTokens }
					: {}),
			});
		}
		return this.harness;
	}

	/**
	 * Run one turn to completion on the provider's session. `onNotification`
	 * receives every wire notification live (including `session.event`),
	 * matching the AI SDK streaming model.
	 */
	async run(
		input: string,
		onNotification: (notification: DshNotification) => void,
	): Promise<{ events: unknown[]; finalResponse: string }> {
		const harness = this.getHarness();
		const result = await harness.run(input, {
			sessionId: this.sessionId,
			onNotification: onNotification as (n: unknown) => void,
		});
		return {
			events: result.events as unknown[],
			finalResponse: result.finalResponse,
		};
	}

	/** Abort the current turn and tear the runtime down (no mid-turn cancel on the wire). */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.harness !== undefined) {
			await this.harness.close();
			this.harness = undefined;
		}
	}
}
