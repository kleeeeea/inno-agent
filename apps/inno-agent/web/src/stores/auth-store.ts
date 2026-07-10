import { EventEmitter } from "./event-emitter.js";
import { getAuthToken, setAuthToken, setUnauthorizedHandler } from "../api/client.js";
import { authStatus, getMe, login as apiLogin, type AuthUser } from "../api/auth.js";

interface AuthStoreEvents {
	change: void;
}

/**
 * 登录态 store（对应参考 EduClaw 的 useAuthStore，换成 inno 的 EventEmitter 模式）。
 *
 * status 状态机：
 * - "checking"        启动时校验 token（或查询后端是否启用鉴权）
 * - "authenticated"   已登录（user 有值）
 * - "unauthenticated" 未登录 → PageContainer 展示登录页
 * - "disabled"        后端关闭了鉴权（config.auth.enabled=false）→ 视同已登录的单用户模式
 */
class AuthStoreImpl extends EventEmitter<AuthStoreEvents> {
	status: "checking" | "authenticated" | "unauthenticated" | "disabled" = "checking";
	user: AuthUser | null = null;

	/** 应用启动时调用一次：查询鉴权开关 + 校验本地 token。 */
	async init(): Promise<void> {
		// 任意请求收到 401 时统一登出（token 过期/被清），登录页自动弹出
		setUnauthorizedHandler(() => this.handleUnauthorized());
		try {
			const { enabled } = await authStatus();
			if (!enabled) {
				this.status = "disabled";
				this.user = null;
				this.emit("change", undefined);
				return;
			}
		} catch {
			// 状态接口失败（老后端/网络抖动）时按未启用处理，避免把用户锁在登录页外
			this.status = "disabled";
			this.emit("change", undefined);
			return;
		}

		if (!getAuthToken()) {
			this.status = "unauthenticated";
			this.emit("change", undefined);
			return;
		}
		try {
			this.user = await getMe();
			this.status = "authenticated";
		} catch {
			setAuthToken(null);
			this.user = null;
			this.status = "unauthenticated";
		}
		this.emit("change", undefined);
	}

	async login(username: string, password: string): Promise<void> {
		const { token, user } = await apiLogin(username, password);
		setAuthToken(token);
		this.user = user;
		this.status = "authenticated";
		this.emit("change", undefined);
	}

	logout(): void {
		setAuthToken(null);
		this.user = null;
		this.status = "unauthenticated";
		this.emit("change", undefined);
	}

	private handleUnauthorized(): void {
		if (this.status !== "authenticated") return;
		setAuthToken(null);
		this.user = null;
		this.status = "unauthenticated";
		this.emit("change", undefined);
	}
}

export const authStore = new AuthStoreImpl();
