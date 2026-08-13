import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";
import {
	classifyDshError,
	createAPICallError,
	createAuthenticationError,
	getErrorMetadata,
	isAPICallError,
	stderrTail,
} from "../src/errors";

describe("stderrTail", () => {
	it("strips ANSI escapes and collapses to the last 5 non-empty lines", () => {
		const raw =
			"\x1b[31merror\x1b[0m\n\n  line two\nline three\n\nline four\nline five\nline six\n";
		const tail = stderrTail(raw);
		expect(tail).toBe("line two; line three; line four; line five; line six");
	});

	it("truncates to 600 chars with a leading ellipsis", () => {
		const long = "x".repeat(800);
		const tail = stderrTail(long);
		expect(tail.length).toBe(600);
		expect(tail.startsWith("…")).toBe(true);
	});

	it("returns empty string for empty input", () => {
		expect(stderrTail("")).toBe("");
	});
});

describe("createAPICallError", () => {
	it("creates an APICallError with dsh metadata and stderr tail enrichment", () => {
		const error = createAPICallError({
			message: "dsh runtime failed",
			stderr: "line1\n  line2  \nline3\nline4\nline5\nline6",
			exitCode: 1,
			isRetryable: true,
			promptExcerpt: "run tests",
		});
		expect(error).toBeInstanceOf(APICallError);
		expect(error.isRetryable).toBe(true);
		expect(error.url).toBe("dsh-runtime://jsonrpc");
		expect(error.message).toContain(
			" | stderr (tail): line2; line3; line4; line5; line6",
		);
		const metadata = error.data as {
			exitCode?: number;
			promptExcerpt?: string;
		};
		expect(metadata.exitCode).toBe(1);
		expect(metadata.promptExcerpt).toBe("run tests");
	});

	it("does not double-append the stderr tail marker", () => {
		const error = createAPICallError({
			message: "boom | stderr (tail): something",
			stderr: "tail content",
		});
		const markers = error.message.split(" | stderr (tail):").length - 1;
		expect(markers).toBe(1);
	});
});

describe("createAuthenticationError", () => {
	it("creates a LoadAPIKeyError", () => {
		const error = createAuthenticationError("DEEPSEEK_API_KEY is missing");
		expect(error).toBeInstanceOf(LoadAPIKeyError);
		expect(error.message).toContain("DEEPSEEK_API_KEY");
	});
});

describe("classifyDshError", () => {
	it("classifies TransportClosedError as retryable APICallError", () => {
		const err = new Error("runtime exited with code 1");
		err.name = "TransportClosedError";
		const classified = classifyDshError(err, "prompt excerpt");
		expect(isAPICallError(classified)).toBe(true);
		if (isAPICallError(classified)) {
			expect(classified.isRetryable).toBe(true);
			expect(getErrorMetadata(classified)?.transportError).toBe(
				"TransportClosedError",
			);
		}
	});

	it("classifies RequestTimeoutError as retryable APICallError", () => {
		const err = new Error("request timed out");
		err.name = "RequestTimeoutError";
		const classified = classifyDshError(err);
		expect(isAPICallError(classified)).toBe(true);
		if (isAPICallError(classified)) {
			expect(classified.isRetryable).toBe(true);
		}
	});

	it("classifies SdkProtocolError as non-retryable APICallError", () => {
		const err = new Error("unexpected wire shape");
		err.name = "SdkProtocolError";
		const classified = classifyDshError(err);
		expect(isAPICallError(classified)).toBe(true);
		if (isAPICallError(classified)) {
			expect(classified.isRetryable).toBe(false);
		}
	});

	it("classifies JsonRpcResponseError as non-retryable APICallError", () => {
		const err = new Error("runtime rejected request");
		err.name = "JsonRpcResponseError";
		const classified = classifyDshError(err);
		expect(isAPICallError(classified)).toBe(true);
		if (isAPICallError(classified)) {
			expect(classified.isRetryable).toBe(false);
		}
	});

	it("classifies node spawn errors (ENOENT) with code metadata", () => {
		const err = new Error("spawn dsh-jsonrpc-agent ENOENT");
		Object.assign(err, { code: "ENOENT" });
		const classified = classifyDshError(err);
		expect(isAPICallError(classified)).toBe(true);
		expect(getErrorMetadata(classified)?.code).toBe("ENOENT");
	});

	it("passes through unknown errors unchanged", () => {
		const original = new Error("plain error");
		expect(classifyDshError(original)).toBe(original);
	});

	it("wraps non-Error throws", () => {
		const classified = classifyDshError("string throw");
		expect(classified).toBeInstanceOf(Error);
		expect(classified.message).toBe("string throw");
	});
});

describe("isAPICallError / getErrorMetadata", () => {
	it("returns undefined metadata for non-APICallError", () => {
		expect(getErrorMetadata(new Error("x"))).toBeUndefined();
	});
});

describe("classifyDshError credential", () => {
	it("classifies DshCredentialError as LoadAPIKeyError", () => {
		const err = new Error("DEEPSEEK_API_KEY is required");
		err.name = "DshCredentialError";
		const classified = classifyDshError(err);
		expect(classified).toBeInstanceOf(LoadAPIKeyError);
		expect(classified.message).toContain("DEEPSEEK_API_KEY");
	});
});
