import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { getCursorSessionCwd } from "./cursor-session-scope.js";
import {
	CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES,
	CURSOR_REPLAY_TOOL_NAMES,
	type NativeCursorToolName,
} from "./cursor-native-tool-names.js";
import { isCursorReplayToolName } from "./cursor-tool-presentation-registry.js";
import { createCursorReplayOnlyToolDefinition } from "./cursor-native-tool-display-replay.js";
import { consumeCursorNativeToolDisplay } from "./cursor-native-tool-display-state.js";

/**
 * OMP port: Pi 0.84 shadowed the builtin read/bash/edit/write/grep/find/ls
 * tools with wrapped definitions to render Cursor-native activity. OMP's
 * extension API exposes builtin tool metadata (getAllTools) but no wrapped
 * definition to delegate execution to, so the port registers only the
 * self-contained replay tool and leaves the builtins untouched. Recorded
 * Cursor activity still flows into results via the execute-time replay
 * consume; the Pi render-time replay cards are a documented fidelity
 * reduction.
 */

export function wrapNativeCursorTool<TParams extends TSchema, TDetails>(
	definition: ToolDefinition<TParams, TDetails>,
	getCurrentDefinition: () => ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return {
		...definition,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cursorDisplay = consumeCursorNativeToolDisplay(toolCallId);
			if (cursorDisplay) {
				if (cursorDisplay.isError) {
					const text = cursorDisplay.result.content
						.map((entry) => (entry.type === "text" ? entry.text : undefined))
						.filter((entry): entry is string => Boolean(entry))
						.join("\n");
					throw new Error(text || "Cursor tool replay failed");
				}
				return {
					content: cursorDisplay.result.content,
					details: cursorDisplay.result.details as TDetails,
					terminate: cursorDisplay.terminate ?? true,
				};
			}
			return getCurrentDefinition().execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

export function createNativeCursorToolDefinition(
	toolName: NativeCursorToolName,
	_cwd: string,
): ToolDefinition<TSchema, unknown> {
	if (isCursorReplayToolName(toolName)) {
		return createCursorReplayOnlyToolDefinition(toolName) as ToolDefinition<TSchema, unknown>;
	}
	throw new Error(`Unsupported Cursor native replay tool: ${toolName}`);
}

export function registerNativeCursorTool(
	pi: Pick<ExtensionAPI, "registerTool">,
	toolName: NativeCursorToolName,
): void {
	const definition = createNativeCursorToolDefinition(toolName, getCursorSessionCwd());
	pi.registerTool(wrapNativeCursorTool(definition, () => createNativeCursorToolDefinition(toolName, getCursorSessionCwd())));
}

export { CURSOR_MODEL_ACTIVE_REPLAY_TOOL_NAMES, CURSOR_REPLAY_TOOL_NAMES };
