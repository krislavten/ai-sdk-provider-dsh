/**
 * Multi-turn — one provider instance, one harness session: the second turn
 * recalls context from the first (the runtime persists the session log).
 *
 * Run: npx tsx examples/multi-turn.ts
 * Requires: DEEPSEEK_API_KEY
 */

import { streamText } from "ai";
import { createDsh } from "../src/index.js";

// A fixed sessionId keeps the SAME harness session across calls. Without it,
// each provider instance still reuses its subprocess, but the session id is
// fresh per provider — pass an explicit id when you need durable continuity.
const dsh = createDsh({
  runtime: {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    sessionId: "example-session-1",
  },
});

async function ask(prompt: string): Promise<string> {
  const result = streamText({
    model: dsh.languageModel("deepseek-v4-flash"),
    prompt,
  });
  return (await result.text).trim();
}

try {
  const t1 = await ask("The secret code is X7Q9. Reply: stored");
  console.log("Turn 1:", t1);

  const t2 = await ask("What is the secret code? Reply with only the code.");
  console.log("Turn 2:", t2);

  if (t2.includes("X7Q9")) {
    console.log("✅ session continuity works — turn 2 recalled turn 1 context");
  } else {
    console.log("⚠️ recall failed — check the session log under .sessions/");
  }
} finally {
  await dsh.close();
}
