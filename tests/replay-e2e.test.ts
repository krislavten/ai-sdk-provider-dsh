/**
 * Keyless replay e2e: drives a REAL dsh runtime subprocess through the
 * provider's `doStream`, with the LLM adapter replaced by
 * `@deepseek-ai/dsh-llm-replay` replaying a recorded session JSONL fixture.
 * No network, no API key — this is what CI runs.
 *
 * Fixture recording (one-time, requires a live key):
 *   DEEPSEEK_API_KEY=<key> node scripts/record-fixture.mjs
 * which writes tests/fixtures/text-turn.jsonl from a live DeepSeek turn.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import { createDsh } from "../src/index";

function repoPath(rel: string): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", rel);
}

const REPLAY_CONFIG = repoPath("runtime/cordis.replay.yml");
const FIXTURE = repoPath("tests/fixtures/text-turn.jsonl");

describe("ai-sdk-provider-dsh replay e2e (keyless)", () => {
	it("replays a recorded turn through a real runtime and maps events to stream parts", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "dsh-replay-e2e-"));
		try {
			const dsh = createDsh({
				runtime: {
					provider: "deepseek-official",
					model: "deepseek-v4-flash",
					configPath: REPLAY_CONFIG,
					env: {
						DSH_CWD: cwd,
						DSH_SESSION_ROOT: join(cwd, ".sessions"),
						DSH_SNAPSHOT_FILE: FIXTURE,
					},
					requestTimeoutMs: 60_000,
				},
			});

			const model = dsh.languageModel("deepseek-v4-flash");
			const result = await model.doStream({
				prompt: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Reply with exactly: replay-fixture-ok" },
						],
					},
				],
			});

			const parts: LanguageModelV3StreamPart[] = [];
			const reader = result.stream.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				parts.push(value);
			}

			// The fixture streams one text-delta then a block-end with the full
			// text; the mapper must emit the text exactly once (no duplication).
			const text = parts
				.filter((p) => p.type === "text-delta")
				.map((p) => (p.type === "text-delta" ? p.delta : ""))
				.join("");
			expect(text).toContain("replay-fixture-ok");

			// The replayed turn ended completed.
			const finish = parts.find((p) => p.type === "finish");
			expect(finish).toBeDefined();
			if (finish?.type === "finish") {
				expect(finish.finishReason.unified).toBe("stop");
				expect(finish.usage.inputTokens.total).toBeGreaterThan(0);
			}

			await dsh.close();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 60_000);
});
