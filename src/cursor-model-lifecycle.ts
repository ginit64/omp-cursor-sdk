import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
	TurnStartEvent,
} from "@oh-my-pi/pi-coding-agent";

export type CursorModelLifecycleContext = ExtensionContext;

type CursorModelSelectEvent = { model: ExtensionContext["model"] };

type CursorModelLifecycleSyncHandler = (ctx: CursorModelLifecycleContext) => Promise<void> | void;
type CursorModelSessionStartHandler = ExtensionHandler<SessionStartEvent>;
type CursorModelSelectHandler = (event: CursorModelSelectEvent, ctx: CursorModelLifecycleContext) => Promise<void> | void;
type CursorModelTurnStartHandler = ExtensionHandler<TurnStartEvent>;
type CursorModelBeforeAgentStartHandler = ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;

export interface CursorModelLifecycleExtensionApi {
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "before_agent_start", handler: CursorModelBeforeAgentStartHandler): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
}

export interface CursorModelLifecycleHandlers {
	sessionStart?: CursorModelSessionStartHandler;
	/** @deprecated OMP has no model-change event; accepted for source parity but never invoked. */
	modelSelect?: CursorModelSelectHandler;
	turnStart?: CursorModelTurnStartHandler;
	sync?: CursorModelLifecycleSyncHandler;
	beforeAgentStart?: CursorModelBeforeAgentStartHandler;
}

function normalizeLifecycleHandlers(
	handlerOrHandlers: CursorModelLifecycleSyncHandler | CursorModelLifecycleHandlers,
): CursorModelLifecycleHandlers {
	return typeof handlerOrHandlers === "function" ? { sync: handlerOrHandlers } : handlerOrHandlers;
}

export function registerCursorModelLifecycle(
	pi: CursorModelLifecycleExtensionApi,
	handlerOrHandlers: CursorModelLifecycleSyncHandler | CursorModelLifecycleHandlers,
): void {
	const handlers = normalizeLifecycleHandlers(handlerOrHandlers);
	const sync = handlers.sync;
	if (handlers.sessionStart || sync) {
		pi.on("session_start", async (event, ctx) => {
			await handlers.sessionStart?.(event, ctx);
			await sync?.(ctx);
		});
	}
	if (handlers.turnStart || sync) {
		pi.on("turn_start", async (event, ctx) => {
			await handlers.turnStart?.(event, ctx);
			await sync?.(ctx);
		});
	}
	if (handlers.beforeAgentStart || sync) {
		pi.on("before_agent_start", async (event, ctx) => {
			await sync?.(ctx);
			return await handlers.beforeAgentStart?.(event, ctx);
		});
	}
}
