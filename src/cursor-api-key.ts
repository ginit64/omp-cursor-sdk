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

/**
 * OMP's model picker and `omp models` only list providers that are
 * config-configured or carry stored auth (`authStorage.hasAuth`); an env key
 * alone keeps the plugin's cursor/* models hidden from /model even though
 * `--model cursor/...` works. Persist the resolved key into OMP's credential
 * store (the same sqlite store the extension reads back) so the provider
 * shows as available. Never overwrites an existing stored credential.
 */
export async function ensureStoredCursorApiKey(): Promise<void> {
	const apiKey = resolveCursorApiKey(process.env.CURSOR_API_KEY);
	if (!apiKey) return;
	try {
		const { SqliteAuthCredentialStore } = await import("@oh-my-pi/pi-coding-agent");
		const store = await SqliteAuthCredentialStore.open();
		try {
			if (store.getApiKey(CURSOR_PROVIDER_ID) === null) {
				store.saveApiKey(CURSOR_PROVIDER_ID, apiKey);
			}
		} finally {
			store.close();
		}
	} catch {
		// Auth persistence is best-effort; the env key still works for turns.
	}
}

export async function resolveCursorRuntimeApiKey(): Promise<string | undefined> {
	return (await getStoredCursorApiKey()) ?? resolveCursorApiKey(process.env.CURSOR_API_KEY);
}
