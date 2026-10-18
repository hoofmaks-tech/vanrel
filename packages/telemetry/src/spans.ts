// Span compatibility with the vendored pi-ai. Types and the NOOP implementation
// are adapted from py/packages/telemetry (Pi fork, MIT): index.ts + noop.ts.

export type AttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

export interface SpanAttributes {
	[name: string]: AttributeValue | undefined;
}

export interface SpanOptions {
	name: string;
	attributes?: SpanAttributes;
}

export type SpanStatus = { status: "ok" } | { status: "error"; error?: { name: string; message: string } };

export interface TelemetryContext {
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

export interface TelemetrySpan extends TelemetryContext {
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}

function startNoopSpan<T>(_options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> {
	try {
		return Promise.resolve(callback(noopTelemetrySpan));
	} catch (error) {
		return Promise.reject(error);
	}
}

const noopTelemetrySpan: TelemetrySpan = {
	startSpan: startNoopSpan,
	addEvent: (): void => {},
	setAttributes: (): void => {},
	setStatus: (): void => {},
};
Object.freeze(noopTelemetrySpan);

/** Shared telemetry context used when an application does not provide one. */
export const NOOP_TELEMETRY_CONTEXT: TelemetryContext = noopTelemetrySpan;
