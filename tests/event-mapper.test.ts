import { describe, expect, it } from "vitest";
import { DshStreamMapper, mapFinishReason } from "../src/event-mapper";

describe("DshStreamMapper", () => {
  it("maps text deltas to framed text parts", () => {
    const mapper = new DshStreamMapper();
    const parts = mapper.feedChunk({ type: "text-delta", index: 0, text: "hello" });
    expect(parts).toEqual([
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: "hello" },
    ]);
  });

  it("maps reasoning deltas to framed reasoning parts", () => {
    const mapper = new DshStreamMapper();
    const parts = mapper.feedChunk({ type: "reasoning-delta", index: 0, text: "think" });
    expect(parts).toEqual([
      { type: "reasoning-start", id: "reasoning" },
      { type: "reasoning-delta", id: "reasoning", delta: "think" },
    ]);
  });

  it("accumulates tool-call deltas and emits provider-executed tool-call at block-end", () => {
    const mapper = new DshStreamMapper();
    mapper.feedChunk({ type: "block-start", index: 0, block: { type: "tool_use" } });
    const deltaParts = mapper.feedChunk({
      type: "tool-call-delta",
      index: 0,
      id: "call_1",
      name: "bash",
      argumentsDelta: "{\"cmd",
    });
    expect(deltaParts).toEqual([{ type: "tool-input-delta", id: "call_1", delta: "{\"cmd" }]);
    mapper.feedChunk({
      type: "tool-call-delta",
      index: 0,
      id: "call_1",
      argumentsDelta: "\":\"ls\"}",
    });
    const endParts = mapper.feedChunk({
      type: "block-end",
      index: 0,
      block: { type: "tool_use", id: "call_1", name: "bash", arguments: "{\"cmd\":\"ls\"}" },
    });
    expect(endParts).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "bash",
        input: "{\"cmd\":\"ls\"}",
        providerExecuted: true,
      },
    ]);
  });

  it("opens a text part but emits no delta for empty text", () => {
    const mapper = new DshStreamMapper();
    expect(mapper.feedChunk({ type: "text-delta", index: 0, text: "" })).toEqual([
      { type: "text-start", id: "text" },
    ]);
  });

  it("finishes with mapped reason and usage", () => {
    const mapper = new DshStreamMapper();
    mapper.feedChunk({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    const parts = mapper.finish("completed");
    expect(parts).toEqual([
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "completed" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
      },
    ]);
  });

  it("emits error part before finish when turn ended in error", () => {
    const mapper = new DshStreamMapper();
    const parts = mapper.finish("error", "boom");
    expect(parts[0]).toMatchObject({ type: "error" });
    expect(parts[1]).toMatchObject({
      type: "finish",
      finishReason: { unified: "error", raw: "error" },
    });
  });

  it("is inert after finish", () => {
    const mapper = new DshStreamMapper();
    mapper.finish("completed");
    expect(mapper.feedChunk({ type: "text-delta", index: 0, text: "late" })).toEqual([]);
  });
});

describe("mapFinishReason", () => {
  it("maps dsh turn end kinds to AI SDK finish reasons", () => {
    expect(mapFinishReason("completed")).toEqual({ unified: "stop", raw: "completed" });
    expect(mapFinishReason("max-tokens")).toEqual({ unified: "length", raw: "max-tokens" });
    expect(mapFinishReason("aborted")).toEqual({ unified: "error", raw: "aborted" });
    expect(mapFinishReason("interrupted")).toEqual({ unified: "error", raw: "interrupted" });
    expect(mapFinishReason("blocked")).toEqual({
      unified: "content-filter",
      raw: "blocked",
    });
    expect(mapFinishReason("error")).toEqual({ unified: "error", raw: "error" });
  });
});
