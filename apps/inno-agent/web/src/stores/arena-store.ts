import { EventEmitter } from "./event-emitter.js";
import type { WorkspaceMeta } from "../api/workspaces.js";
import type { SessionMeta } from "../api/sessions.js";

interface ArenaStoreEvents {
	change: void;
}

/** 一场 Arena 对战 = 一对 arena-a-* / arena-b-* 工作区（各自绑一个会话）。 */
export interface ArenaHistory {
	key: string;
	label: string;
	aWorkspaceId: string;
	bWorkspaceId: string;
	aSessionId: string | null;
	bSessionId: string | null;
	updatedAt: string;
	preview: string;
}

export function isArenaGeneratedWorkspace(id: string): boolean {
	return id.startsWith("arena-a-") || id.startsWith("arena-b-");
}

export function arenaHistoryKey(name: string): { side: "a" | "b"; key: string } | null {
	const match = name.match(/^Arena\s+([AB])\s+(.+)$/i);
	if (!match) return null;
	return { side: match[1].toLowerCase() as "a" | "b", key: match[2] };
}

/** 从工作区 + 会话列表还原出历史对战列表（按更新时间倒序）。 */
export function buildArenaHistories(
	workspaces: Array<WorkspaceMeta | undefined>,
	sessions: SessionMeta[],
): ArenaHistory[] {
	const sessionById = new Map(sessions.map((session) => [session.id, session]));
	const pairs = new Map<string, Partial<ArenaHistory>>();
	for (const workspace of workspaces) {
		if (!workspace || !isArenaGeneratedWorkspace(workspace.id)) continue;
		const parsed = arenaHistoryKey(workspace.name);
		if (!parsed) continue;
		const existing = pairs.get(parsed.key) ?? { key: parsed.key, label: parsed.key, preview: "", updatedAt: workspace.updatedAt };
		const sessionId = workspace.sessionIds?.[0] ?? null;
		const session = sessionId ? sessionById.get(sessionId) : undefined;
		const next: Partial<ArenaHistory> = {
			...existing,
			updatedAt: Date.parse(workspace.updatedAt) > Date.parse(existing.updatedAt ?? "") ? workspace.updatedAt : existing.updatedAt,
			preview: existing.preview || session?.preview || "",
		};
		if (parsed.side === "a") {
			next.aWorkspaceId = workspace.id;
			next.aSessionId = sessionId;
		} else {
			next.bWorkspaceId = workspace.id;
			next.bSessionId = sessionId;
		}
		pairs.set(parsed.key, next);
	}
	return Array.from(pairs.values())
		.filter((history): history is ArenaHistory => Boolean(history.aWorkspaceId && history.bWorkspaceId))
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/**
 * Arena 入场状态机（Claude 主题下的上下分屏对比模式）。
 *
 * 交互约定：在"新建对话"欢迎屏上点击 Arena 只是"预约"（armed=true），
 * 界面仍停留在欢迎屏；用户点击发送时才 launch(prompt) 真正进入上下分屏，
 * 首条 prompt 由 ClaudeArenaApp 挂载后 consumePendingPrompt() 取走并
 * 同时发给 Arena A / Arena B 两条 lane。
 */
class ArenaStoreImpl extends EventEmitter<ArenaStoreEvents> {
	/** 欢迎屏上已选中 Arena、等待第一条消息触发进场。 */
	armed = false;
	/** 进场时待自动双发的首条 prompt，被消费后立即清空。 */
	pendingPrompt: string | null = null;
	/** 从聊天侧边栏点开的历史对战，进场后由 ClaudeArenaApp 取走并恢复。 */
	pendingHistory: ArenaHistory | null = null;

	arm(): void {
		if (this.armed) return;
		this.armed = true;
		this.emit("change", undefined);
	}

	disarm(): void {
		if (!this.armed) return;
		this.armed = false;
		this.emit("change", undefined);
	}

	/** 带着首条 prompt 进入 Arena（由欢迎屏的发送动作触发）。 */
	launch(prompt: string): void {
		this.armed = false;
		this.pendingPrompt = prompt;
		this.emit("change", undefined);
	}

	/** 取走待发 prompt（一次性，防止 StrictMode 重复副作用导致双发）。 */
	consumePendingPrompt(): string | null {
		const prompt = this.pendingPrompt;
		this.pendingPrompt = null;
		return prompt;
	}

	/** 从聊天侧边栏打开一场历史对战（触发切换到 Arena 视图）。 */
	openHistory(history: ArenaHistory): void {
		this.armed = false;
		this.pendingHistory = history;
		this.emit("change", undefined);
	}

	/** 取走待恢复的历史对战（一次性）。 */
	consumePendingHistory(): ArenaHistory | null {
		const history = this.pendingHistory;
		this.pendingHistory = null;
		return history;
	}
}

export const arenaStore = new ArenaStoreImpl();
