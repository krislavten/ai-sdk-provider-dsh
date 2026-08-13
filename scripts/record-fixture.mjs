#!/usr/bin/env node
/**
 * One-shot fixture recorder for keyless CI tests.
 *
 * Runs a live turn (or the multi-turn scenario) against DeepSeek official
 * with DEEPSEEK_API_KEY, then copies the uncompressed session JSONL into
 * tests/fixtures/. The fixtures are replayed in CI by
 * @deepseek-ai/dsh-llm-replay (see runtime/cordis.replay.yml) so tests never
 * need a real key.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... node scripts/record-fixture.mjs
 *   DEEPSEEK_API_KEY=sk-... node scripts/record-fixture.mjs --multi
 */

import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createDsh } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const multi = process.argv.includes("--multi");

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is required (live recording calls the DeepSeek API)");
  process.exit(1);
}

const cwd = await mkdtemp(join(tmpdir(), "dsh-record-"));
const dsh = createDsh({
  runtime: {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
    configPath: resolve(repoRoot, "runtime/cordis.minimal.yml"),
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: apiKey,
      DSH_CWD: cwd,
      DSH_SESSION_ROOT: join(cwd, ".sessions"),
      DSH_SNAPSHOT: "record", // forces compression: none in cordis.yml
    },
    requestTimeoutMs: 120_000,
  },
});
const model = dsh.languageModel("deepseek-v4-flash");

async function runTurn(prompt) {
  const result = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });
  const reader = result.stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const text = parts
    .filter((p) => p.type === "text-delta")
    .map((p) => (p.type === "text-delta" ? p.delta : ""))
    .join("");
  console.log("turn:", JSON.stringify(text));
  return text;
}

let dest;
if (multi) {
  await runTurn("The secret code is X7Q9. Reply: stored");
  const recall = await runTurn("What is the secret code? Reply with only the code.");
  if (!recall.includes("X7Q9")) {
    console.error("multi-turn recall failed; session continuity broken — fixture would be misleading");
    process.exit(1);
  }
  dest = join(repoRoot, "tests/fixtures/multi-turn.jsonl");
} else {
  await runTurn("Reply with exactly: replay-fixture-ok");
  dest = join(repoRoot, "tests/fixtures/text-turn.jsonl");
}

await dsh.close().catch(() => {});

const found = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p);
    else if (entry.name.endsWith(".jsonl")) found.push(p);
  }
}
await walk(join(cwd, ".sessions"));
if (found.length === 0) throw new Error("no plain .jsonl session log found");
await cp(found[0], dest);
await rm(cwd, { recursive: true, force: true });
console.log("fixture written:", dest);
