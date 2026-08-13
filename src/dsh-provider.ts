/**
 * Provider factory: `createDsh(options)` returns a `ProviderV3`-shaped object
 * whose `languageModel(id)` yields a `LanguageModelV3` driving a dsh runtime.
 *
 * The returned provider is structurally compatible with both AI SDK v6 and
 * v7 consumption (`ai.model()` / `customProvider` / `generateText({model})`).
 */

import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { DshRuntimeOptions } from "./runtime";
import { DshRuntime } from "./runtime";
import { createDshLanguageModel } from "./language-model";

export interface CreateDshOptions {
  /**
   * Runtime options: how to spawn the dsh harness runtime, its model route,
   * and its session identity.
   */
  runtime: DshRuntimeOptions;
  /** Provider id reported to the AI SDK; defaults to "dsh". */
  providerId?: string;
}

export interface DshProvider {
  /** The provider's model id (the id passed to the runtime handshake). */
  readonly modelId: string;
  /** Create the AI SDK language model for the configured model id. */
  languageModel(modelId?: string): LanguageModelV3;
  /** Create the AI SDK language model (alias matching AI SDK provider convention). */
  (modelId?: string): LanguageModelV3;
  /** Tear down the runtime subprocess (idempotent). */
  close(): Promise<void>;
}

export function createDsh(options: CreateDshOptions): DshProvider {
  const providerId = options.providerId ?? "dsh";
  const runtime = new DshRuntime(options.runtime);

  const languageModel = (modelId?: string): LanguageModelV3 =>
    createDshLanguageModel({
      providerId,
      modelId: modelId ?? options.runtime.model,
      runtime,
    });

  const provider: DshProvider = Object.assign(languageModel, {
    modelId: options.runtime.model,
    languageModel,
    async close() {
      await runtime.close();
    },
  });

  return provider;
}
