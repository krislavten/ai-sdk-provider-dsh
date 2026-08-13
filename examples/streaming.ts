/**
 * Streaming — observe real-time text and reasoning deltas as the harness
 * streams them.
 *
 * Run: npx tsx examples/streaming.ts
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

try {
  const result = streamText({
    model: dsh.languageModel("deepseek-v4-flash"),
    prompt: "Write one sentence about why tests matter.",
  });

  for await (const part of result.stream) {
    switch (part.type) {
      case "text-delta":
        process.stdout.write(part.text);
        break;
      case "reasoning-delta":
        process.stdout.write(`\x1b[90m${part.text}\x1b[0m`); // dim reasoning
        break;
      case "tool-call":
        console.log(`\n[tool: ${part.toolName}]`);
        break;
      case "finish":
        console.log(`\n[finish: ${part.finishReason}]`);
        break;
      default:
        break;
    }
  }
} finally {
  await dsh.close();
}
