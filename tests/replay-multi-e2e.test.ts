/**
 * Keyless multi-turn + doGenerate e2e over the recorded `multi-turn.jsonl`
 * fixture (a real DeepSeek session where turn 1 stores a secret code and
 * turn 2 recalls it).
 *
 * - `doStream` twice on the SAME provider instance (fixed sessionId) must
 *   replay turn 1 then turn 2 from the fixture — proving session continuity
 *   and the replay cursor advancing across calls.
 * - `doGenerate` on a fresh provider must replay the FIRST turn from the
 *   fixture and return aggregated text + metadata.
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
const MULTI_FIXTURE = repoPath("tests/fixtures/multi-turn.jsonl");
const TEXT_FIXTURE = repoPath("tests/fixtures/text-turn.jsonl");

function makeProvider(fixture: string, sessionRoot: string) {
	return createDsh({
		runtime: {
			provider: "deepseek-official",
			model: "deepseek-v4-flash",
			configPath: REPLAY_CONFIG,
			env: {
				DSH_SESSION_ROOT: sessionRoot,
				DSH_SNAPSHOT_FILE: fixture,
			},
			requestTimeoutMs: 60_000,
		},
	});
}

async function streamText(
	provider: ReturnType<typeof makeProvider>,
	prompt: string,
): Promise<string> {
	const model = provider.languageModel("deepseek-v4-flash");
	const result = await model.doStream({
		prompt: [{ role: "user", content: [{ type: "text", text: prompt }] }],
	});
	const reader = result.stream.getReader();
	const parts: LanguageModelV3StreamPart[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value);
	}
	return parts
		.filter((p) => p.type === "text-delta")
		.map((p) => (p.type === "text-delta" ? p.delta : ""))
		.join("");
}

describe("ai-sdk-provider-dsh multi-turn replay e2e (keyless)", () => {
	it("replays two consecutive turns on the same provider with session continuity", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "dsh-multi-e2e-"));
		try {
			const provider = makeProvider(MULTI_FIXTURE, join(cwd, ".sessions"));
			const t1 = await streamText(
				provider,
				"The secret code is X7Q9. Reply: stored",
			);
			expect(t1).toContain("stored");
			const t2 = await streamText(
				provider,
				"What is the secret code? Reply with only the code.",
			);
			expect(t2).toContain("X7Q9");
			await provider.close();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 60_000);
});

describe("ai-sdk-provider-dsh doGenerate replay e2e (keyless)", () => {
	it("aggregates a replayed turn into a generate result with metadata", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "dsh-gen-e2e-"));
		try {
			const provider = makeProvider(TEXT_FIXTURE, join(cwd, ".sessions"));
			const model = provider.languageModel("deepseek-v4-flash");
			const result = await model.doGenerate({
				prompt: [
					{
						role: "user",
						content: [
							{ type: "text", text: "Reply with exactly: replay-fixture-ok" },
						],
					},
				],
			});
			const text = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			expect(text).toContain("replay-fixture-ok");
			expect(result.finishReason).toEqual({
				unified: "stop",
				raw: "completed",
			});
			expect(result.usage.inputTokens.total).toBeGreaterThan(0);
			const meta = (result.providerMetadata as { dsh?: { sessionId?: string } })
				.dsh;
			expect(typeof meta?.sessionId).toBe("string");
			await provider.close();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 60_000);
});
