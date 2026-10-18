import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generatePKCE } from "../../src/auth/oauth/pkce.ts";

describe("PKCE (vendored, V3)", () => {
	it("roundtrip: challenge === base64url(SHA256(verifier))", async () => {
		const { verifier, challenge } = await generatePKCE();
		const expected = createHash("sha256").update(verifier).digest("base64url");
		expect(challenge).toBe(expected);
	});

	it("verifier: 43 base64url chars (32 bytes), no padding", async () => {
		const { verifier, challenge } = await generatePKCE();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("two calls produce different pairs (CSPRNG)", async () => {
		const a = await generatePKCE();
		const b = await generatePKCE();
		expect(a.verifier).not.toBe(b.verifier);
		expect(a.challenge).not.toBe(b.challenge);
	});
});
