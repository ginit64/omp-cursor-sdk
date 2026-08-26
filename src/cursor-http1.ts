import type { CursorSdkModule } from "./cursor-sdk-runtime.js";
import type { CursorResolvedSetting } from "./cursor-config.js";
import { asRecord } from "./cursor-record-utils.js";

export const CURSOR_HTTP1_ENTRY_TYPE = "cursor-http1-state";

export interface CursorHttp1EntryData {
	enabled: boolean;
}

type CursorHttp1Sdk = {
	Cursor: Pick<CursorSdkModule["Cursor"], "configure">;
};

export interface CursorHttp1RuntimeOptions {
	/** Test/runtime override. Omit to detect Bun from process.versions.bun. */
	bunRuntime?: boolean;
}

let sessionCursorHttp1Enabled: boolean | undefined;
let globalPreferenceAuthoritative = false;
let configuredCursor: CursorHttp1Sdk["Cursor"] | undefined;

export function isCursorHttp1EntryData(value: unknown): value is CursorHttp1EntryData {
	return typeof asRecord(value)?.enabled === "boolean";
}

export function getStoredCursorHttp1Enabled(): boolean | undefined {
	return sessionCursorHttp1Enabled;
}

export function setStoredCursorHttp1Enabled(enabled: boolean | undefined): void {
	sessionCursorHttp1Enabled = enabled;
}

export function getResolvedSessionCursorHttp1Enabled(): boolean | undefined {
	return globalPreferenceAuthoritative ? undefined : sessionCursorHttp1Enabled;
}

export function setCursorHttp1GlobalPreferenceAuthoritative(authoritative: boolean): void {
	globalPreferenceAuthoritative = authoritative;
}

export function clearCursorSdkHttp1(): void {
	if (configuredCursor === undefined) return;
	configuredCursor.configure({ local: { useHttp1ForAgent: null } });
	configuredCursor = undefined;
}

function isBunRuntime(): boolean {
	return typeof process.versions.bun === "string";
}

export function configureCursorSdkHttp1(
	sdk: CursorHttp1Sdk,
	setting: CursorResolvedSetting<boolean>,
	options: CursorHttp1RuntimeOptions = {},
): boolean | undefined {
	// An explicit setting always wins, including PI_CURSOR_HTTP_1_1=0.
	if (setting.source !== "builtin") {
		sdk.Cursor.configure({ local: { useHttp1ForAgent: setting.value } });
		configuredCursor = sdk.Cursor;
		return setting.value;
	}

	// OMP executes extensions inside Bun. Cursor local-agent HTTP/2 has had
	// Bun-specific transport failures, while the SDK exposes an HTTP/1.1
	// fallback specifically for the local agent transport. Force that safer
	// transport by default under Bun; Node keeps the SDK's own default.
	const bunRuntime = options.bunRuntime ?? isBunRuntime();
	if (bunRuntime) {
		sdk.Cursor.configure({ local: { useHttp1ForAgent: true } });
		configuredCursor = sdk.Cursor;
		return true;
	}

	if (configuredCursor === sdk.Cursor) clearCursorSdkHttp1();
	else configuredCursor = undefined;
	return undefined;
}

export const __testUtils = {
	reset(): void {
		sessionCursorHttp1Enabled = undefined;
		globalPreferenceAuthoritative = false;
		configuredCursor = undefined;
	},
};
