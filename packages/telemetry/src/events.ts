export type FlightEventType =
	| "session_start"
	| "session_end"
	| "llm_request"
	| "llm_response"
	| "tool_call"
	| "tool_result"
	| "error";

export interface FlightEventEnvelope {
	v: 1; // schema version
	seq: number; // monotonic number within the session, from 1
	ts: number; // ms epoch
	sessionId: string; // uuid v4
	type: FlightEventType;
	payload: FlightPayload; // discriminated union by type
}

export type FlightPayload =
	| SessionStartPayload
	| SessionEndPayload
	| LlmRequestPayload
	| LlmResponsePayload
	| ToolCallPayload
	| ToolResultPayload
	| ErrorPayload;

/** Discriminated map of payloads by event type — compile-time binding of record(type, payload). */
export interface FlightPayloadMap {
	session_start: SessionStartPayload;
	session_end: SessionEndPayload;
	llm_request: LlmRequestPayload;
	llm_response: LlmResponsePayload;
	tool_call: ToolCallPayload;
	tool_result: ToolResultPayload;
	error: ErrorPayload;
}

export interface SessionStartPayload {
	cwd: string;
	argv: string[];
	pid: number;
	vanrelVersion: string;
	gitRev?: string;
	providers: string[]; // ids of available auth providers
}

export interface SessionEndPayload {
	reason: "user_exit" | "error" | "completed";
	stats: {
		turns: number;
		llmRequests: number;
		toolCalls: number;
		inputTokens: number;
		outputTokens: number;
		durationMs: number;
	};
}

export interface LlmRequestPayload {
	provider: string;
	model: string;
	baseUrl: string;
	request: unknown; // FULL request body (raw)
	budgetContext: { W: number; S: number; T: number; H: number; R: number; U: number };
}

export interface LlmResponsePayload {
	provider: string;
	model: string;
	stopReason: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number };
	message: unknown; // FULL raw assistant response
	durationMs: number;
}

export interface ToolCallPayload {
	toolCallId: string;
	tool: string;
	args: unknown;
}

export interface ToolResultPayload {
	toolCallId: string;
	tool: string;
	durationMs: number;
	isError: boolean;
	rawOutput: string; // FULL output (no truncation — this is disk, not context)
	filteredOutput: string; // what was sent to the LLM
	filterStats?: { class: string; inputBytes: number; outputBytes: number; omittedLines: number };
}

export interface ErrorPayload {
	scope: string; // "auth" | "llm" | "tool" | "qc" | "session"
	message: string;
	stack?: string;
	fatal: boolean;
}
