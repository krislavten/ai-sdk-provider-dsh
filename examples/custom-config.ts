/**
 * Custom runtime config — point the bundled runtime at a different cordis
 * composition (here the no-pty minimal one) and a custom workspace.
 *
 * Run: npx tsx examples/custom-config.ts
 * Requires: DEEPSEEK_API_KEY
 */

import { generateText } from "ai";
import { createDsh } from "../src/index.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const minimalConfig = join(__dirname, "../runtime/cordis.minimal.yml");

const dsh = createDsh({
  runtime: {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    // No-pty composition: use where node-pty cannot build (minimal
    // containers, WSL without libc6-dev). Loses the bash tool.
    configPath: minimalConfig,
    // The harness workspace: bash/fs tools operate here.
    env: {
      DSH_CWD: "/tmp",
      DSH_SESSION_ROOT: "/tmp/.dsh-sessions",
    },
    sessionId: "custom-config-example",
  },
});

try {
  const { text } = await generateText({
    model: dsh.languageModel("deepseek-v4-flash"),
    prompt: "Say 'custom config ok'",
  });
  console.log(text);
} finally {
  await dsh.close();
}
