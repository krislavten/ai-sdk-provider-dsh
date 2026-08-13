/**
 * Error classification for the dsh runtime boundary.
 *
 * The provider surfaces failures from two layers:
 * 1. The dsh SDK client transport (`@deepseek-ai/dsh-sdk-client`), which
 *    throws typed errors (`TransportClosedError`, `RequestTimeoutError`,
 *    `SdkProtocolError`, `JsonRpcResponseError`).
 * 2. The runtime subprocess itself (via the SDK's `stderr` tail, carried in
 *    `TransportClosedError` messages).
 *
 * Following ai-sdk-provider-claude-code's pattern, every surfaced error is
 * normalized to an AI SDK `APICallError` (retryable classification + URL +
 * request excerpt) with the dsh metadata preserved on `data`, and consumer
 * predicates are exported so callers can branch on the failure class.
 */

import { APICallError, LoadAPIKeyError } from "@ai-sdk/provider";

export const STDERR_TAIL_MARKER = " | stderr (tail):";

const ANSI_ESCAPE_SEQUENCE =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI CSI/OSC escapes (deliberate, see stderrTail)
	/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;

/** Convert raw stderr into a short single-line tail for error messages. */
export function stderrTail(raw: string): string {
	const withoutAnsi = raw.replace(ANSI_ESCAPE_SEQUENCE, "");
	const tail = withoutAnsi
		.split(/\r\n|\r|\n|\u2028|\u2029/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(-5)
		.join("; ");
	return tail.length > 600 ? `…${tail.slice(-599)}` : tail;
}

/** Metadata associated with dsh runtime failures. */
export interface DshErrorMetadata {
	/** Error code (e.g. `ENOENT` when the runtime bin is missing). */
	code?: string;
	/** Exit code of the runtime subprocess. */
	exitCode?: number;
	/** Standard error output from the runtime subprocess. */
	stderr?: string;
	/** Excerpt of the prompt that caused the failure (first 200 chars). */
	promptExcerpt?: string;
	/** The SDK transport error class name, when the failure came from the wire. */
	transportError?: string;
}

export interface CreateDshErrorOptions {
	message: string;
	isRetryable?: boolean;
	code?: string;
	exitCode?: number;
	stderr?: string;
	promptExcerpt?: string;
	transportError?: string;
}

/**
 * Create an AI SDK `APICallError` with dsh metadata, appending a sanitized
 * stderr tail to the message (mirrors ai-sdk-provider-claude-code).
 */
export function createAPICallError({
	message,
	isRetryable = false,
	code,
	exitCode,
	stderr,
	promptExcerpt,
	transportError,
}: CreateDshErrorOptions): APICallError {
	const metadata: DshErrorMetadata = {
		code,
		exitCode,
		stderr,
		promptExcerpt,
		transportError,
	};
	const tail =
		typeof stderr === "string" && stderr.length > 0 ? stderrTail(stderr) : "";
	const enrichedMessage =
		tail && !message.includes(STDERR_TAIL_MARKER)
			? `${message}${STDERR_TAIL_MARKER} ${tail}`
			: message;

	return new APICallError({
		message: enrichedMessage,
		isRetryable,
		url: "dsh-runtime://jsonrpc",
		requestBodyValues: promptExcerpt ? { prompt: promptExcerpt } : undefined,
		data: metadata,
	});
}

/** Create an authentication error (missing/invalid DEEPSEEK_API_KEY). */
export function createAuthenticationError(message: string): LoadAPIKeyError {
	return new LoadAPIKeyError({ message });
}

/**
 * Classify an arbitrary thrown value from the dsh runtime boundary into an
 * AI SDK error. Unknown errors pass through as-is (the caller can still
 * surface them), known transport classes are normalized.
 */
export function classifyDshError(
	error: unknown,
	promptExcerpt?: string,
): Error {
	if (error instanceof Error) {
		const name = error.name;
		const message = error.message;
		// Missing DEEPSEEK_API_KEY — surfaced by DshRuntime.assertCredentialPresent.
		if (name === "DshCredentialError") {
			return createAuthenticationError(message);
		}
		// Transport closed: the runtime subprocess died or its stdio closed.
		if (name === "TransportClosedError") {
			return createAPICallError({
				message: `dsh runtime subprocess failed: ${message}`,
				isRetryable: true,
				transportError: name,
				promptExcerpt,
			});
		}
		// Request timeout: the JSON-RPC request exceeded the configured bound.
		if (name === "RequestTimeoutError") {
			return createAPICallError({
				message: `dsh runtime request timed out: ${message}`,
				isRetryable: true,
				transportError: name,
				promptExcerpt,
			});
		}
		// Protocol violation: the runtime answered outside the documented wire.
		if (name === "SdkProtocolError") {
			return createAPICallError({
				message: `dsh runtime protocol violation: ${message}`,
				isRetryable: false,
				transportError: name,
				promptExcerpt,
			});
		}
		// JSON-RPC error response (e.g. an LLM failure surfaced by the runtime).
		if (name === "JsonRpcResponseError") {
			return createAPICallError({
				message: `dsh runtime request rejected: ${message}`,
				isRetryable: false,
				transportError: name,
				promptExcerpt,
			});
		}
		// Node spawn failures (ENOENT for a missing bin) — retryable is false:
		// a missing binary will not fix itself, but a transient EAGAIN could;
		// keep the original error type so callers see the real cause.
		if ("code" in error && typeof error.code === "string") {
			return createAPICallError({
				message: `dsh runtime could not be started: ${message}`,
				isRetryable: error.code === "EAGAIN" || error.code === "EMFILE",
				code: error.code,
				promptExcerpt,
			});
		}
	}
	return error instanceof Error ? error : new Error(String(error));
}

/** Whether an error was classified as an API call failure. */
export function isAPICallError(error: unknown): error is APICallError {
	return error instanceof APICallError;
}

/** Extract the dsh metadata from an error, when present. */
export function getErrorMetadata(error: unknown): DshErrorMetadata | undefined {
	if (error instanceof APICallError) {
		return error.data as DshErrorMetadata | undefined;
	}
	return undefined;
}
