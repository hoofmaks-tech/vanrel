import { describe, expect, it } from "vitest";
import { NOOP_TELEMETRY_CONTEXT, type TelemetrySpan } from "../src/index.ts";

describe("NOOP_TELEMETRY_CONTEXT", () => {
	it("executes the callback and returns its result", async () => {
		const result = await NOOP_TELEMETRY_CONTEXT.startSpan({ name: "op", attributes: { k: "v" } }, (span) => {
			span.addEvent("evt", { n: 1 });
			span.setAttributes({ done: true });
			span.setStatus({ status: "ok" });
			span.setStatus({ status: "error", error: { name: "E", message: "m" } });
			return 42;
		});
		expect(result).toBe(42);
	});

	it("supports nested spans and async callbacks", async () => {
		const inner = await NOOP_TELEMETRY_CONTEXT.startSpan({ name: "outer" }, (span: TelemetrySpan) =>
			span.startSpan({ name: "inner" }, async () => "nested"),
		);
		expect(inner).toBe("nested");
	});

	it("a synchronous throw in the callback becomes a rejected promise", async () => {
		await expect(
			NOOP_TELEMETRY_CONTEXT.startSpan({ name: "fail" }, (): never => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});
});
