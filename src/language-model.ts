/**
 * The `LanguageModelV3` implementation that drives a dsh runtime.
 *
 * `specificationVersion: 'v3'` is the interface shared by AI SDK v6
 * (`@ai-sdk/provider@3`) and v7 (`@ai-sdk/provider@4`) — v7 accepts V3
 * models first-class (`asLanguageModelV3` passes them through), so a single
 * build runs on both majors.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
} from "@ai-sdk/provider";

import { DshRuntime, type DshNotification } from "./runtime";
import { DshStreamMapper, type DshTurnEndKind } from "./event-mapper";

interface DshSessionEventEnvelope {
  type: string;
  data?: {
    turn?: number;
    step?: number;
    chunk?: unknown;
    reason?: { kind?: string };
    error?: { message?: string; code?: string };
  };
}

export interface DshLanguageModelOptions {
  /** Provider id reported to the AI SDK (logging). */
  providerId: string;
  /** Model id reported to the AI SDK (logging) and passed to the runtime. */
  modelId: string;
  /** Runtime + harness session options. */
  runtime: DshRuntime;
}

function asSessionEvent(notification: DshNotification): DshSessionEventEnvelope | undefined {
  if (notification.method !== "session.event") return undefined;
  const params = notification.params as { sessionId?: unknown; event?: unknown };
  return params.event as DshSessionEventEnvelope | undefined;
}

/** Collects per-call turn outcome from the notification stream. */
class TurnObserver {
  private kind: DshTurnEndKind | undefined;
  private error: { message?: string; code?: string } | undefined;

  observe(notification: DshNotification): void {
    const event = asSessionEvent(notification);
    if (event === undefined) return;
    if (event.type === "turn/end" && event.data?.reason?.kind !== undefined) {
      this.kind = event.data.reason.kind as DshTurnEndKind;
      this.error = event.data.error;
    }
  }

  get kindOrCompleted(): DshTurnEndKind {
    return this.kind ?? "completed";
  }

  get errorMessage(): string | undefined {
    return this.error?.message;
  }
}

export function createDshLanguageModel(options: DshLanguageModelOptions): LanguageModelV3 {
  const { providerId, modelId, runtime } = options;

  return {
    specificationVersion: "v3",
    provider: providerId,
    modelId,
    supportedUrls: {},

    async doGenerate(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const prompt = toPromptText(callOptions);
      const mapper = new DshStreamMapper();
      const observer = new TurnObserver();

      await runtime.run(prompt, (notification) => {
        const event = asSessionEvent(notification);
        if (event === undefined) return;
        if (event.type === "assistant/chunk" && event.data?.chunk !== undefined) {
          mapper.feedChunk(event.data.chunk);
        }
        observer.observe(notification);
      });

      mapper.finish(observer.kindOrCompleted, observer.errorMessage);

      const textDeltas = mapper.assembled.filter(
        (part): part is Extract<LanguageModelV3StreamPart, { type: "text-delta" }> =>
          part.type === "text-delta",
      );
      const content: LanguageModelV3Content[] = [
        { type: "text", text: textDeltas.map((p) => p.delta).join("") },
      ];

      const finishPart = mapper.assembled.find((part) => part.type === "finish");
      return {
        content,
        finishReason: finishPart?.finishReason ?? { unified: "stop", raw: "completed" },
        usage: finishPart?.usage ?? {
          inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 0, text: 0, reasoning: 0 },
        },
        warnings: [],
      };
    },

    async doStream(callOptions: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const prompt = toPromptText(callOptions);
      const mapper = new DshStreamMapper();
      const observer = new TurnObserver();

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          try {
            await runtime.run(prompt, (notification) => {
              const event = asSessionEvent(notification);
              if (event === undefined) return;
              if (event.type === "assistant/chunk" && event.data?.chunk !== undefined) {
                const parts = mapper.feedChunk(event.data.chunk);
                for (const part of parts) controller.enqueue(part);
              }
              observer.observe(notification);
            });
          } catch (error) {
            const terminal = mapper.finish(
              "error",
              error instanceof Error ? error.message : String(error),
            );
            for (const part of terminal) controller.enqueue(part);
            controller.close();
            return;
          }

          const terminal = mapper.finish(observer.kindOrCompleted, observer.errorMessage);
          for (const part of terminal) controller.enqueue(part);
          controller.close();
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
  if (typeof output === "object" && "content" in (output as Record<string, unknown>)) {
    const content = (output as Record<string, unknown>).content;
    if (typeof content === "string") return content;
  }
  return JSON.stringify(output);
}
