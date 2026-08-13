/**
 * Abort — cancel a stream mid-flight with an AbortController. The provider
 * surfaces the ORIGINAL abort reason (an AbortError, never a wrapped
 * transport error).
 *
 * Run: npx tsx examples/abort.ts
 * Requires: DEEPSEEK_API_KEY
 */

import { streamText } from "ai";
import { createDsh } from "../src/index.js";

const dsh = createDsh({
  runtime: {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  },
});

const controller = new AbortController();

try {
  const result = streamText({
    model: dsh.languageModel("deepseek-v4-flash"),
    prompt: "Count slowly from 1 to 100, one number per line.",
    abortSignal: controller.signal,
  });

  // Cancel after the first chunk arrives.
  const firstChunk = await result.stream.getReader().read();
  console.log("First chunk:", firstChunk.value?.type ?? "done");
  controller.abort(new DOMException("user cancelled", "AbortError"));

  // Drain the rest — the stream should reject with AbortError.
  const reader = result.stream.getReader();
  for (;;) {
    try {
      const { done } = await reader.read();
      if (done) break;
    } catch (error) {
      console.log("Aborted as expected:", (error as Error).name);
      break;
    }
  }
} finally {
  await dsh.close();
}
