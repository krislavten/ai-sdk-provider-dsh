/**
 * The `LanguageModelV3` implementation that drives a dsh runtime.
 *
 * `specificationVersion: 'v3'` is the interface shared by AI SDK v6
 * (`@ai-sdk/provider@3`) and v7 (`@ai-sdk/provider@4`) — v7 accepts V3
 * models first-class (`asLanguageModelV3` passes them through), so a single
 * build runs on both majors.
 *
 * Error handling follows ai-sdk-provider-claude-code's pattern: transport
 * failures are classified into AI SDK `APICallError`s (with retryability and
 * a sanitized stderr tail), abort signals are preserved (the original abort
 * reason is rethrown, never wrapped), and every result carries rich
 * `providerMetadata` under the `dsh` key.
 */

import type {
	LanguageModelV3,
	LanguageModelV3CallOptions,
	LanguageModelV3Content,
	LanguageModelV3GenerateResult,
	LanguageModelV3StreamPart,
	LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

import { classifyDshError } from "./errors";
import { DshStreamMapper, type DshTurnEndKind } from "./event-mapper";
import type { DshNotification, DshRuntimeLike } from "./runtime";

interface DshSessionEventEnvelope {
	type: string;
	seq?: number;
	data?: {
		turn?: number;
		step?: number;
		chunk?: unknown;
		reason?: { kind?: string };
		error?: { message?: string; code?: string };
		usage?: {
			inputTokens?: number;
			outputTokens?: number;
			totalTokens?: number;
		};
	};
}

/** providerMetadata payload under the `dsh` key. */
export interface DshProviderMetadata {
	/** The harness session id this call ran on. */
	sessionId: string;
	/** Last observed turn number, when the runtime reported one. */
	turnId?: number;
	/** Final turn end kind, when observed. */
	terminalReason?: DshTurnEndKind;
}

export interface DshLanguageModelOptions {
	/** Provider id reported to the AI SDK (logging). */
	providerId: string;
	/** Model id reported to the AI SDK (logging) and passed to the runtime. */
	modelId: string;
	/** Runtime + harness session options. */
	runtime: DshRuntimeLike;
}

function asSessionEvent(
	notification: DshNotification,
): DshSessionEventEnvelope | undefined {
	if (notification.method !== "session.event") return undefined;
	const params = notification.params as {
		sessionId?: unknown;
		event?: unknown;
	};
	return params.event as DshSessionEventEnvelope | undefined;
}

/** Collects per-call turn outcome and metadata from the notification stream. */
class TurnObserver {
	private kind: DshTurnEndKind | undefined;
	private error: { message?: string; code?: string } | undefined;
	private turnId: number | undefined;

	observe(notification: DshNotification): void {
		const event = asSessionEvent(notification);
		if (event === undefined) return;
		if (event.type === "turn/end" && event.data?.reason?.kind !== undefined) {
			this.kind = event.data.reason.kind as DshTurnEndKind;
			this.error = event.data.error;
		}
		if (typeof event.data?.turn === "number") {
			this.turnId = event.data.turn;
		}
	}

	get kindOrCompleted(): DshTurnEndKind {
		return this.kind ?? "completed";
	}

	get errorMessage(): string | undefined {
		return this.error?.message;
	}

	get lastTurnId(): number | undefined {
		return this.turnId;
	}
}

/** Bridge `options.abortSignal` to the call: rethrow the original reason on abort. */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: new Error(String(signal.reason));
	}
}

/** First 200 chars of the flattened prompt, for error diagnostics. */
function promptExcerpt(
	callOptions: LanguageModelV3CallOptions,
): string | undefined {
	const text = toPromptText(callOptions);
	if (text.length === 0) return undefined;
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export function createDshLanguageModel(
	options: DshLanguageModelOptions,
): LanguageModelV3 {
	const { providerId, modelId, runtime } = options;

	return {
		specificationVersion: "v3",
		provider: providerId,
		modelId,
		supportedUrls: {},

		async doGenerate(
			callOptions: LanguageModelV3CallOptions,
		): Promise<LanguageModelV3GenerateResult> {
			const prompt = toPromptText(callOptions);
			const excerpt = promptExcerpt(callOptions);
			const mapper = new DshStreamMapper();
			const observer = new TurnObserver();

			try {
				await runtime.run(prompt, (notification) => {
					const event = asSessionEvent(notification);
					if (event === undefined) return;
					if (
						event.type === "assistant/chunk" &&
						event.data?.chunk !== undefined
					) {
						mapper.feedChunk(event.data.chunk);
					}
					observer.observe(notification);
				});
			} catch (error) {
				throw classifyDshError(error, excerpt);
			}

			mapper.finish(observer.kindOrCompleted, observer.errorMessage);

			const textDeltas = mapper.assembled.filter(
				(
					part,
				): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
					part.type === "text-delta",
			);
			const content: LanguageModelV3Content[] = [
				{ type: "text", text: textDeltas.map((p) => p.delta).join("") },
			];

			const finishPart = mapper.assembled.find(
				(part) => part.type === "finish",
			);
			return {
				content,
				finishReason: finishPart?.finishReason ?? {
					unified: "stop",
					raw: "completed",
				},
				usage: finishPart?.usage ?? {
					inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 0, text: 0, reasoning: 0 },
				},
				warnings: [],
				providerMetadata: {
					dsh: {
						sessionId: runtime.sessionId,
						...(observer.lastTurnId !== undefined
							? { turnId: observer.lastTurnId }
							: {}),
						...(observer.kindOrCompleted !== "completed"
							? { terminalReason: observer.kindOrCompleted }
							: {}),
					} satisfies DshProviderMetadata,
				},
			};
		},

		async doStream(
			callOptions: LanguageModelV3CallOptions,
		): Promise<LanguageModelV3StreamResult> {
			const prompt = toPromptText(callOptions);
			const excerpt = promptExcerpt(callOptions);
			const abortSignal = callOptions.abortSignal;
			const mapper = new DshStreamMapper();
			const observer = new TurnObserver();

			const stream = new ReadableStream<LanguageModelV3StreamPart>({
				async start(controller) {
					let aborted = false;
					const onAbort = (): void => {
						aborted = true;
					};

					try {
						throwIfAborted(abortSignal);
						abortSignal?.addEventListener("abort", onAbort, { once: true });

						await runtime.run(prompt, (notification) => {
							const event = asSessionEvent(notification);
							if (event === undefined) return;
							if (
								event.type === "assistant/chunk" &&
								event.data?.chunk !== undefined
							) {
								const parts = mapper.feedChunk(event.data.chunk);
								for (const part of parts) controller.enqueue(part);
							}
							observer.observe(notification);
						});
					} catch (error) {
						// Abort wins: the caller asked us to stop; surface the original
						// reason rather than a transport classification.
						if (aborted || abortSignal?.aborted) {
							throw abortSignal?.reason instanceof Error
								? abortSignal.reason
								: new Error(String(abortSignal?.reason));
						}
						const classified = classifyDshError(error, excerpt);
						const terminal = mapper.finish("error", classified.message);
						for (const part of terminal) controller.enqueue(part);
						controller.close();
						return;
					} finally {
						abortSignal?.removeEventListener("abort", onAbort);
					}

					// Abort may have fired DURING run() while the runtime settled
					// normally — the abort must still win over the completed turn.
					if (aborted || abortSignal?.aborted) {
						throw abortSignal?.reason instanceof Error
							? abortSignal.reason
							: new Error(String(abortSignal?.reason));
					}

					const terminal = mapper.finish(
						observer.kindOrCompleted,
						observer.errorMessage,
					);
					for (const part of terminal) controller.enqueue(part);
					controller.close();
				},
				cancel() {
					// The consumer stopped reading: nothing to clean up synchronously —
					// the runtime subprocess stays alive for the provider instance and
					// is torn down on `provider.close()`.
				},
			});

			return { stream };
		},
	};
}

/** Flatten a V3 prompt into a single text prompt for the dsh runtime. */
function toPromptText(callOptions: LanguageModelV3CallOptions): string {
	const parts: string[] = [];
	for (const message of callOptions.prompt) {
		if (message.role === "system") {
			parts.push(message.content);
			continue;
		}
		if (message.role === "user") {
			for (const part of message.content) {
				if (part.type === "text") parts.push(part.text);
			}
			continue;
		}
		if (message.role === "assistant") {
			for (const part of message.content) {
				if (part.type === "text") parts.push(part.text);
			}
			continue;
		}
		if (message.role === "tool") {
			for (const part of message.content) {
				if (part.type === "tool-result") {
					parts.push(
						`[tool ${part.toolName ?? part.toolCallId} result: ${stringifyToolOutput(part.output)}]`,
					);
				}
			}
		}
	}
	return parts.join("\n\n");
}

function stringifyToolOutput(output: unknown): string {
	if (typeof output === "string") return output;
	if (output === null || output === undefined) return "";
	if (
		typeof output === "object" &&
		"content" in (output as Record<string, unknown>)
	) {
		const content = (output as Record<string, unknown>).content;
		if (typeof content === "string") return content;
	}
	return JSON.stringify(output);
}
