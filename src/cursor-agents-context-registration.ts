import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import { resolveEffectiveCursorConfigForContext } from "./cursor-runtime-state.js";
import { resolveCursorFacingSystemPrompt } from "./cursor-agents-context.js";

export type CursorAgentsContextExtensionApi = CursorModelLifecycleExtensionApi;

export function registerCursorAgentsContextDedup(pi: CursorAgentsContextExtensionApi): void {
	registerCursorModelLifecycle(pi, {
		beforeAgentStart: (event, ctx) => {
			if (!isCursorModel(ctx.model)) return undefined;
			const runtime = resolveEffectiveCursorConfigForContext(ctx).runtime.value;
			const systemPrompt = event.systemPrompt.join("\n");
			// OMP's before_agent_start carries no systemPromptOptions; the
			// context-files dedup is inert today. When it does rewrite,
			// append the resolved result rather than collapsing the element
			// array (preserves OMP's block boundaries).
			const resolved = resolveCursorFacingSystemPrompt(
				systemPrompt,
				ctx.model,
				undefined,
				undefined,
				undefined,
				runtime,
			);
			if (resolved === systemPrompt) return undefined;
			return { systemPrompt: [...event.systemPrompt, resolved] };
		},
	});
}
