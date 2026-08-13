/**
 * Maps DeepSeek Harness session events (the `session.event` wire stream) onto
 * AI SDK `LanguageModelV3StreamPart`s.
 *
 * The dsh runtime executes tools INTERNALLY (it owns the agent loop and the
 * `ctx.tools` pipeline), so the provider is a pass-through — the AI SDK never
 * executes tools itself (`getTools()` is not part of a LanguageModel; the
 * provider simply reports tool activity as provider-executed `tool-call`
 * parts). Tool calls are surfaced with `providerExecuted: true` so the AI SDK
 * records them without requiring the caller to run them.
 *
 * Chunk → part mapping (dsh `StreamChunk` vocabulary):
 * - `text-delta` → `text-delta` (with `text-start`/`text-end` framing)
 * - `reasoning-delta` → `reasoning-delta` (with framing)
 * - `tool-call-delta` → `tool-input-delta` (with `tool-input-start`/`end`)
 * - `block-end` (tool_use) → `tool-call` (providerExecuted)
 * - `usage` → captured for the terminal `finish` part
 * - `finish` / `turn/end` → `finish` with mapped reason
 */

import type {
	LanguageModelV3FinishReason,
	LanguageModelV3StreamPart,
	LanguageModelV3Usage,
} from "@ai-sdk/provider";

/** Finish reasons dsh can report, mapped to AI SDK vocabulary. */
export type DshTurnEndKind =
	| "completed"
	| "aborted"
	| "blocked"
	| "error"
	| "max-tokens"
	| "interrupted";

export function mapFinishReason(
	kind: DshTurnEndKind,
): LanguageModelV3FinishReason {
	switch (kind) {
		case "completed":
			return { unified: "stop", raw: "completed" };
		case "aborted":
		case "interrupted":
			return { unified: "error", raw: kind };
		case "blocked":
			return { unified: "content-filter", raw: "blocked" };
		case "max-tokens":
			return { unified: "length", raw: "max-tokens" };
		case "error":
			return { unified: "error", raw: "error" };
		default: {
			const exhaustive: never = kind;
			return exhaustive;
		}
	}
}

export interface DshUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

export function toV3Usage(
	usage: DshUsage | undefined,
): LanguageModelV3Usage | undefined {
	if (usage === undefined) return undefined;
	return {
		inputTokens: {
			total: usage.inputTokens ?? 0,
			noCache: usage.inputTokens ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		outputTokens: {
			total: usage.outputTokens ?? 0,
			text: usage.outputTokens ?? 0,
			reasoning: 0,
		},
	};
}

interface DshToolCallBlock {
	type?: string;
	id?: string;
	name?: string;
	arguments?: string;
	text?: string;
}

interface DshStreamChunk {
	type?: string;
	index?: number;
	text?: string;
	id?: string;
	name?: string;
	argumentsDelta?: string;
	block?: DshToolCallBlock;
	usage?: DshUsage;
}

/**
 * An incremental event mapper that assembles stream parts from raw dsh
 * `assistant/chunk` events plus turn lifecycle events.
 *
 * Stateful per model call: tracks the open text/reasoning/tool-input part
 * ids, accumulates tool-call argument deltas between `block-start` and
 * `block-end`, and records the latest usage snapshot for the terminal part.
 */
export class DshStreamMapper {
	private readonly parts: LanguageModelV3StreamPart[] = [];
	private readonly toolArgBuffers = new Map<string, string>();
	private latestUsage: LanguageModelV3Usage | undefined;
	private finished = false;
	private textPartId: string | undefined;
	private reasoningPartId: string | undefined;
	/** Whether the open text/reasoning part already emitted a delta (block-end carries the FULL block, so it must not duplicate deltas). */
	private textPartHasDelta = false;
	private reasoningPartHasDelta = false;
	private openToolInputIds = new Set<string>();

	/**
	 * Feed one raw chunk (the `assistant/chunk` event's `chunk` field).
	 * Returns the AI SDK parts produced by this chunk (possibly empty).
	 */
	feedChunk(chunk: unknown): LanguageModelV3StreamPart[] {
		if (this.finished) return [];
		const c = chunk as DshStreamChunk;
		const out: LanguageModelV3StreamPart[] = [];

		switch (c.type) {
			case "block-start": {
				const blockType = c.block?.type;
				if (blockType === "text") {
					this.textPartId = `text-${c.index ?? 0}`;
					out.push({ type: "text-start", id: this.textPartId });
				} else if (blockType === "reasoning") {
					this.reasoningPartId = `reasoning-${c.index ?? 0}`;
					out.push({ type: "reasoning-start", id: this.reasoningPartId });
				}
				break;
			}
			case "text-delta": {
				if (this.textPartId === undefined) {
					this.textPartId = "text";
					out.push({ type: "text-start", id: this.textPartId });
				}
				if (typeof c.text === "string" && c.text.length > 0) {
					this.textPartHasDelta = true;
					out.push({ type: "text-delta", id: this.textPartId, delta: c.text });
				}
				break;
			}
			case "reasoning-delta": {
				if (this.reasoningPartId === undefined) {
					this.reasoningPartId = "reasoning";
					out.push({ type: "reasoning-start", id: this.reasoningPartId });
				}
				if (typeof c.text === "string" && c.text.length > 0) {
					this.reasoningPartHasDelta = true;
					out.push({
						type: "reasoning-delta",
						id: this.reasoningPartId,
						delta: c.text,
					});
				}
				break;
			}
			case "tool-call-delta": {
				const id =
					typeof c.id === "string" ? c.id : `tool-${this.parts.length}`;
				const current = this.toolArgBuffers.get(id) ?? "";
				const delta =
					typeof c.argumentsDelta === "string" ? c.argumentsDelta : "";
				this.toolArgBuffers.set(id, current + delta);
				if (!this.openToolInputIds.has(id)) {
					this.openToolInputIds.add(id);
					out.push({
						type: "tool-input-start",
						id,
						toolName: typeof c.name === "string" ? c.name : "tool",
					});
				}
				out.push({
					type: "tool-input-delta",
					id,
					delta,
				});
				break;
			}
			case "block-end": {
				const block = c.block;
				if (block?.type === "tool_use" || block?.type === "tool-call") {
					const id =
						typeof block.id === "string"
							? block.id
							: `tool-${this.parts.length}`;
					const args =
						typeof block.arguments === "string" ? block.arguments : "{}";
					if (this.openToolInputIds.has(id)) {
						this.openToolInputIds.delete(id);
						out.push({ type: "tool-input-end", id });
					}
					out.push({
						type: "tool-call",
						toolCallId: id,
						toolName: typeof block.name === "string" ? block.name : "unknown",
						input: args,
						providerExecuted: true,
					});
				} else if (block?.type === "text" && typeof block.text === "string") {
					if (this.textPartId === undefined) {
						this.textPartId = "text";
						out.push({ type: "text-start", id: this.textPartId });
					}
					// The runtime streams `text-delta` chunks AND a final `block-end`
					// carrying the FULL assembled text. Emit the full text only when
					// no delta was seen (non-streaming adapters), never duplicate.
					if (!this.textPartHasDelta && block.text.length > 0) {
						out.push({
							type: "text-delta",
							id: this.textPartId,
							delta: block.text,
						});
					}
					out.push({ type: "text-end", id: this.textPartId });
					this.textPartId = undefined;
					this.textPartHasDelta = false;
				} else if (
					block?.type === "reasoning" &&
					typeof block.text === "string"
				) {
					if (this.reasoningPartId === undefined) {
						this.reasoningPartId = "reasoning";
						out.push({ type: "reasoning-start", id: this.reasoningPartId });
					}
					if (!this.reasoningPartHasDelta && block.text.length > 0) {
						out.push({
							type: "reasoning-delta",
							id: this.reasoningPartId,
							delta: block.text,
						});
					}
					out.push({ type: "reasoning-end", id: this.reasoningPartId });
					this.reasoningPartId = undefined;
					this.reasoningPartHasDelta = false;
				}
				break;
			}
			case "usage": {
				const v3 = toV3Usage(c.usage);
				if (v3 !== undefined) this.latestUsage = v3;
				break;
			}
			default:
				break;
		}

		if (out.length > 0) this.parts.push(...out);
		return out;
	}

	/**
	 * Signal turn completion. Returns the terminal parts: finish (with reason
	 * and usage), plus an error part when the turn ended in error.
	 */
	finish(
		kind: DshTurnEndKind,
		errorMessage?: string,
	): LanguageModelV3StreamPart[] {
		if (this.finished) return [];
		this.finished = true;
		const reason = mapFinishReason(kind);
		const terminal: LanguageModelV3StreamPart[] = [];
		if (
			kind === "error" &&
			errorMessage !== undefined &&
			errorMessage.length > 0
		) {
			terminal.push({ type: "error", error: new Error(errorMessage) });
		}
		terminal.push({
			type: "finish",
			finishReason: reason,
			usage: this.latestUsage ?? emptyUsage(),
		});
		this.parts.push(...terminal);
		return terminal;
	}

	/** The parts assembled so far (for tests / diagnostics). */
	get assembled(): readonly LanguageModelV3StreamPart[] {
		return this.parts;
	}
}

function emptyUsage(): LanguageModelV3Usage {
	return {
		inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 0, text: 0, reasoning: 0 },
	};
}
