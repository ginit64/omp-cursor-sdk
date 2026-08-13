import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type CursorActiveToolApi = Pick<ExtensionAPI, "getActiveTools">;

export function arePiToolsDisabled(pi: CursorActiveToolApi): boolean {
	return pi.getActiveTools().length === 0;
}
