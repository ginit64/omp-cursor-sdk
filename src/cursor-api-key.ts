export const CURSOR_API_KEY_ENV_VAR = "CURSOR_API_KEY";
const CURSOR_PROVIDER_ID = "cursor";

import type { ApiKey } from "@oh-my-pi/pi-ai";

// Non-secret literal sentinel for pi's provider registry. Pi 0.77 treats `$ENV_VAR`
// values as unconfigured when the env var is absent, which hides fallback models
// before `/login`. Keep the provider available and resolve the real key in the
// Cursor provider turn path from pi auth or CURSOR_API_KEY.
export const CURSOR_API_KEY_CONFIG_VALUE = "pi-cursor-sdk-cursor-api-key-placeholder";

const CURSOR_API_KEY_PLACEHOLDERS = new Set([
	CURSOR_API_KEY_ENV_VAR,
	`$${CURSOR_API_KEY_ENV_VAR}`,
	`\${${CURSOR_API_KEY_ENV_VAR}}`,
	CURSOR_API_KEY_CONFIG_VALUE,
]);

export function resolveCursorApiKey(apiKey?: string): string | undefined {
	const trimmed = apiKey?.trim();
	if (!trimmed) return undefined;
	if (CURSOR_API_KEY_PLACEHOLDERS.has(trimmed)) return process.env.CURSOR_API_KEY?.trim() || undefined;
	return trimmed;
}

/** Resolve an ApiKey that may be a resolver; only literal string keys are usable by the Cursor SDK. */
export function resolveCursorStringApiKey(apiKey: ApiKey | undefined): string | undefined {
	return typeof apiKey === "string" ? resolveCursorApiKey(apiKey) : undefined;
}

async function getStoredCursorApiKey(): Promise<string | undefined> {
	try {
		const { SqliteAuthCredentialStore } = await import("@oh-my-pi/pi-coding-agent");
		const store = await SqliteAuthCredentialStore.open();
		try {
			const key = store.getApiKey(CURSOR_PROVIDER_ID);
			return resolveCursorApiKey(typeof key === "string" ? key : undefined);
		} finally {
			store.close();
		}
	} catch {
		return undefined;
	}
}

export async function resolveCursorRuntimeApiKey(): Promise<string | undefined> {
	return (await getStoredCursorApiKey()) ?? resolveCursorApiKey(process.env.CURSOR_API_KEY);
}
