/**
 * End-to-end test: drives a REAL dsh runtime subprocess through the provider's
 * `doStream`, with a local mock DeepSeek-compatible SSE server as the model
 * endpoint (DEEPSEEK_BASE_URL) — no network, no API key.
 *
 * The mock model server emits a scripted SSE chat-completions stream; the
 * harness agent loop consumes it, and the provider maps the runtime's
 * `session.event` stream into AI SDK stream parts.
 */

import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createDsh } from "../src/index";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

/** Resolve the minimal no-pty runtime config (no node-pty build needed). */
function minimalConfigPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "runtime", "cordis.minimal.yml");
}

function sse(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Scripted model: emits two text deltas then finishes. */
async function startMockModelServer(): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body) as unknown);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse({ choices: [{ delta: { role: "assistant", content: "hello " } }] }));
      response.write(sse({ choices: [{ delta: { content: "world" } }] }));
      response.write(
        sse({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        }),
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock server did not bind a TCP port");
  }
  return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

describe("ai-sdk-provider-dsh e2e (mock model server)", () => {
  it("runs a real dsh runtime turn and maps events to stream parts", async () => {
    const { server, url, requests } = await startMockModelServer();
    const cwd = await mkdtemp(join(tmpdir(), "dsh-provider-e2e-"));

    try {
      const dsh = createDsh({
        runtime: {
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
          configPath: minimalConfigPath(),
          env: {
            DEEPSEEK_API_KEY: "test-key",
            DEEPSEEK_BASE_URL: url,
            DSH_CWD: cwd,
            DSH_SESSION_ROOT: join(cwd, ".sessions"),
          },
          requestTimeoutMs: 60_000,
        },
      });

      const model = dsh.languageModel("deepseek-v4-flash");
      const result = await model.doStream({
        prompt: [{ role: "user", content: [{ type: "text", text: "say hello" }] }],
      });

      const parts: LanguageModelV3StreamPart[] = [];
      const reader = result.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
      }

      expect(requests.length).toBeGreaterThan(0);
      // The runtime's model request hit our mock endpoint with a chat-completions body.
      const firstRequest = requests[0] as { model?: string; messages?: unknown[] };
      expect(firstRequest.model).toBe("deepseek-v4-flash");
      expect(Array.isArray(firstRequest.messages)).toBe(true);

      const text = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => (p.type === "text-delta" ? p.delta : ""))
        .join("");
      expect(text).toContain("hello");
      expect(text).toContain("world");

      const finish = parts.find((p) => p.type === "finish");
      expect(finish).toBeDefined();
      if (finish?.type === "finish") {
        expect(finish.finishReason.unified).toBe("stop");
      }

      await dsh.close();
    } finally {
      server.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 120_000);
});
