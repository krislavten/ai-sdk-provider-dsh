/**
 * Basic usage — the simplest possible example: generate text with dsh and
 * inspect token usage + provider metadata.
 *
 * Run: npx tsx examples/basic-usage.ts
 * Requires: DEEPSEEK_API_KEY (see README)
 */

import { generateText } from "ai";
import { createDsh, getErrorMetadata } from "../src/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const minimalConfig = join(__dirname, "../runtime/cordis.minimal.yml");

const dsh = createDsh({
  runtime: {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    // No-pty composition keeps the example runnable everywhere (the bundled
    // default cordis.yml adds the bash tool and needs node-pty at install).
    configPath: minimalConfig,
  },
});

try {
  const result = await generateText({
    model: dsh.languageModel("deepseek-v4-flash"),
    prompt: "Say hello in exactly three words.",
  });

  console.log("Text:", result.text);
  console.log("Usage:", JSON.stringify(result.usage, null, 2));
  // v6: result.providerMetadata; v7: result.finalStep.providerMetadata
  const meta = result.providerMetadata ?? (await result.finalStep)?.providerMetadata;
  console.log("dsh metadata:", JSON.stringify(meta?.dsh, null, 2));
} catch (error) {
  console.error("Failed:", (error as Error).message);
  const metadata = getErrorMetadata(error);
  if (metadata) console.error("metadata:", metadata);
} finally {
  await dsh.close();
}
