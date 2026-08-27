import { describe, expect, it } from "vitest";
import { normalizeCursorPiToolBridgeImportError } from "../src/cursor-pi-tool-bridge-server.js";

describe("Bun bridge import errors", () => {
	it("preserves a ResolveMessage-style inherited module-resolution message", () => {
		const resolveMessage = Object.create({
			message: "Cannot find module '@modelcontextprotocol/sdk/server/index.js' from '/tmp/omp-cursor-sdk/src/cursor-pi-tool-bridge-run.ts'",
		}) as object;

		expect(Object.keys(resolveMessage)).toEqual([]);
		expect(resolveMessage).not.toBeInstanceOf(Error);

		const normalized = normalizeCursorPiToolBridgeImportError(resolveMessage);
		expect(normalized).toBeInstanceOf(Error);
		expect(normalized.message).toContain("Cannot find module '@modelcontextprotocol/sdk/server/index.js'");
		expect((normalized as Error & { cause?: unknown }).cause).toBe(resolveMessage);
	});
});
