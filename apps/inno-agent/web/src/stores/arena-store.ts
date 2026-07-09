import { EventEmitter } from "./event-emitter.js";

interface ArenaStoreEvents {
	change: void;
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
}

export const arenaStore = new ArenaStoreImpl();
