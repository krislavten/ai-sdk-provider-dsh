/**
 * ai-sdk-provider-dsh — AI SDK provider that drives a DeepSeek Harness (dsh)
 * runtime as a language model.
 *
 * Public API:
 * - `createDsh(options)` — provider factory (returns a callable provider +
 *   `languageModel(id)`).
 * - `DshRuntime` / `DshRuntimeOptions` — runtime subprocess management.
 * - `createDshLanguageModel` — build a `LanguageModelV3` from explicit parts.
 * - `DshStreamMapper` / `mapFinishReason` — session-event → AI SDK part mapping.
 * - Error helpers: `createAPICallError`, `createAuthenticationError`,
 *   `classifyDshError`, `stderrTail`, `isAPICallError`, `getErrorMetadata`.
 */

export {
	createDsh,
	type CreateDshOptions,
	type DshProvider,
} from "./dsh-provider";
export { DshRuntime, type DshRuntimeOptions } from "./runtime";
export {
	createDshLanguageModel,
	type DshLanguageModelOptions,
	type DshProviderMetadata,
} from "./language-model";
export {
	DshStreamMapper,
	mapFinishReason,
	type DshTurnEndKind,
} from "./event-mapper";
export {
	createAPICallError,
	createAuthenticationError,
	classifyDshError,
	getErrorMetadata,
	isAPICallError,
	stderrTail,
	type DshErrorMetadata,
} from "./errors";
