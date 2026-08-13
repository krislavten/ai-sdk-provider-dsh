/**
 * Unit tests for the LanguageModel implementation, driving it with a FAKE
 * runtime (no subprocess, no network). This is the ai-sdk-provider-claude-code
 * test philosophy: unit tests mock the process boundary with synthetic event
 * streams; only e2e tests touch a real runtime.
 */

import type {
	LanguageModelV3CallOptions,
	LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createDshLanguageModel } from "../src/language-model";
import type { DshNotification } from "../src/runtime";

/** Minimal duck-typed fake of DshRuntime. */
class FakeRuntime {
	readonly sessionId = "fake-session-1";
	constructor(
		private readonly emit: (
			onNotification: (n: DshNotification) => void,
		) => Promise<void>,
	) {}

	async run(
		_input: string,
		onNotification: (n: DshNotification) => void,
	): Promise<{ events: unknown[]; finalResponse: string }> {
		await this.emit(onNotification);
		return { events: [], finalResponse: "" };
	}

	async close(): Promise<void> {}
}

function event(type: string, data: Record<string, unknown>): DshNotification {
	return {
		method: "session.event",
		params: { sessionId: "fake-session-1", event: { type, data } },
	};
}

function chunkChunk(chunk: Record<string, unknown>): DshNotification {
	return event("assistant/chunk", { chunk });
}

function turnEnd(kind: string, error?: { message: string }): DshNotification {
	return event("turn/end", { reason: { kind }, ...(error ? { error } : {}) });
}

const userPrompt: LanguageModelV3CallOptions = {
	prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

async function collectStream(result: {
	stream: ReadableStream<LanguageModelV3StreamPart>;
}): Promise<LanguageModelV3StreamPart[]> {
	const reader = result.stream.getReader();
	const parts: LanguageModelV3StreamPart[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	return parts;
}

describe("createDshLanguageModel doStream", () => {
	it("maps a text turn to framed parts and a stop finish", async () => {
		const runtime = new FakeRuntime(async (onNotification) => {
			onNotification(
				chunkChunk({ type: "text-delta", index: 0, text: "hello " }),
			);
			onNotification(
				chunkChunk({ type: "text-delta", index: 0, text: "world" }),
			);
			onNotification(turnEnd("completed"));
		});
		const model = createDshLanguageModel({
			providerId: "dsh",
			modelId: "m",
			runtime,
		});

		const parts = await collectStream(await model.doStream(userPrompt));
		expect(parts).toEqual([
			{ type: "text-start", id: "text" },
			{ type: "text-delta", id: "text", delta: "hello " },
			{ type: "text-delta", id: "text", delta: "world" },
			{
				type: "finish",
				finishReason: { unified: "stop", raw: "completed" },
				usage: expect.any(Object),
			},
		]);
	});

	it("maps turn error to error part + finish", async () => {
		const runtime = new FakeRuntime(async (onNotification) => {
			onNotification(turnEnd("error", { message: "llm boom" }));
		});
		const model = createDshLanguageModel({
			providerId: "dsh",
			modelId: "m",
			runtime,
		});

		const parts = await collectStream(await model.doStream(userPrompt));
		expect(parts[0]).toMatchObject({ type: "error" });
		expect(parts[1]).toMatchObject({
			type: "finish",
			finishReason: { unified: "error", raw: "error" },
		});
	});

	it("surfaces a runtime transport failure as classified APICallError part", async () => {
		const runtime = new FakeRuntime(async () => {
			const err = new Error("runtime exited");
			err.name = "TransportClosedError";
			throw err;
		});
		const model = createDshLanguageModel({
			providerId: "dsh",
			modelId: "m",
			runtime,
		});

		const parts = await collectStream(await model.doStream(userPrompt));
		expect(parts[0]).toMatchObject({ type: "error" });
		expect(parts[1]).toMatchObject({
			type: "finish",
			finishReason: { unified: "error", raw: "error" },
		});
	});

	it("preserves the abort reason when the signal fires mid-run", async () => {
		const abortController = new AbortController();
		const runtime = new FakeRuntime(async (onNotification) => {
			onNotification(
				chunkChunk({ type: "text-delta", index: 0, text: "partial" }),
			);
			abortController.abort(new DOMException("user cancelled", "AbortError"));
			// Simulate the runtime settling after abort.
			onNotification(turnEnd("completed"));
		});
		const model = createDshLanguageModel({
			providerId: "dsh",
			modelId: "m",
			runtime,
		});

		const result = await model.doStream({
			...userPrompt,
			abortSignal: abortController.signal,
		});
		const reader = result.stream.getReader();
		// Already-enqueued parts drain first; the stream then errors with the
		// original abort reason.
		let sawAbort = false;
		for (;;) {
			try {
				const { done } = await reader.read();
				if (done) break;
			} catch (error) {
				expect(error).toMatchObject({ name: "AbortError" });
				sawAbort = true;
				break;
			}
		}
		expect(sawAbort).toBe(true);
	});

	it("throws the abort reason from the stream when the signal is already aborted", async () => {
		const abortController = new AbortController();
		abortController.abort(new Error("already aborted"));
		const runtime = new FakeRuntime(async () => {});
		const model = createDshLanguageModel({
			providerId: "dsh",
			modelId: "m",
			runtime,
		});

		const result = await model.doStream({
			...userPrompt,
			abortSignal: abortController.signal,
		});
		const reader = result.stream.getReader();
		await expect(reader.read()).rejects.toThrow("already aborted");
	});

	it("reports tool calls as provider-executed parts", async () => {
		const runtime = new FakeRuntime(async (onNotification) => {
			onNotification(
				chunkChunk({
					type: "block-start",
					index: 0,
					block: { type: "tool_use" },
				}),
			);
			onNotification(
				chunkChunk({
					type: "tool-call-delta",
					index: 0,
					id: "call_1",
					name: "bash",
					argumentsDelta: '{"cmd":"ls"}',
				}),
			);
			onNotification(
				chunkChunk({
					type: "block-end",
					index: 0,
					block: {
						type: "tool_use",
						id: "call_1",
						name: "bash",
						arguments: '{"cmd":"ls"}',
					},
				}),
			);
			onNotification(
				chunkChunk({ type: "block-start", index: 1, block: { type: "text" } }),
			);
			onNotification(
				chunkChunk({ type: "text-delta", index: 1, text: "done" }),
			);
			onNotification(
				chunkChunk({
					type: "block-end",
					index: 1,
					block: { type: "text", text: "done" },
				}),
			);
			onNotification(turnEnd("completed"));
		});
		const model = createDshLanguageModel({
			providerId: "dsh",
			modelId: "m",
			runtime,
		});

		const parts = await collectStream(await model.doStream(userPrompt));
		const toolCall = parts.find((p) => p.type === "tool-call");
		expect(toolCall).toMatchObject({
			type: "tool-call",
			toolCallId: "call_1",
			toolName: "bash",
			input: '{"cmd":"ls"}',
			providerExecuted: true,
		});
		const text = parts
			.filter((p) => p.type === "text-delta")
			.map((p) => (p.type === "text-delta" ? p.delta : ""))
			.join("");
		expect(text).toBe("done");
	});
});

describe("createDshLanguageModel doGenerate", () => {
	it("aggregates streamed text and metadata from a completed turn", async () => {
		const runtime = new FakeRuntime(async (onNotification) => {
			onNotification(
				chunkChunk({ type: "text-delta", index: 0, text: "answer" }),
			);
			onNotification(
				chunkChunk({
					type: "usage",
					usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
				}),
			);
			onNotification(turnEnd("completed"));
		});
		const model = createDshLanguageModel({
			providerId: "dsh",
			modelId: "m",
			runtime,
		});

		const result = await model.doGenerate(userPrompt);
		expect(result.content).toEqual([{ type: "text", text: "answer" }]);
		expect(result.finishReason).toEqual({ unified: "stop", raw: "completed" });
		expect(result.usage.inputTokens.total).toBe(10);
		expect(result.usage.outputTokens.total).toBe(2);
		const meta = (result.providerMetadata as { dsh?: { sessionId?: string } })
			.dsh;
		expect(meta?.sessionId).toBe("fake-session-1");
	});

	it("classifies a runtime transport failure and throws", async () => {
		const runtime = new FakeRuntime(async () => {
			const err = new Error("protocol violation");
			err.name = "SdkProtocolError";
			throw err;
		});
		const model = createDshLanguageModel({
			providerId: "dsh",
			modelId: "m",
			runtime,
		});

		await expect(model.doGenerate(userPrompt)).rejects.toMatchObject({
			isRetryable: false,
		});
	});

	it("reports turn error as error finish reason", async () => {
		const runtime = new FakeRuntime(async (onNotification) => {
			onNotification(turnEnd("max-tokens"));
		});
		const model = createDshLanguageModel({
			providerId: "dsh",
			modelId: "m",
			runtime,
		});

		const result = await model.doGenerate(userPrompt);
		expect(result.finishReason).toEqual({
			unified: "length",
			raw: "max-tokens",
		});
	});
});
