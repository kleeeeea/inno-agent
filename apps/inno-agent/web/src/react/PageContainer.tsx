import { StrictMode, useCallback, useEffect, useState, type ReactNode } from "react";
import { MessageSquare, Swords } from "lucide-react";
import { settingsStore } from "../stores/settings-store.js";
import { themeStore, type ThemeId } from "../stores/theme-store.js";
import { useStoreSnapshot } from "./hooks.js";
import { ClaudeArenaApp } from "./ClaudeArenaApp.js";

type ClaudeViewMode = "chat" | "arena";
const CLAUDE_VIEW_MODE_KEY = "inno.claudeViewMode";

function readClaudeViewMode(): ClaudeViewMode {
	const saved = localStorage.getItem(CLAUDE_VIEW_MODE_KEY);
	return saved === "chat" || saved === "arena" ? saved : "arena";
}

/**
 * 页面容器控件 — 应用的最外层外壳，由 main.tsx 直接挂载。
 *
 * 职责：
 * - 提供页面级容器（占满视口、背景色跟随当前主题变量），
 *   之后页面级的全局 UI（横幅、全局弹层等）都挂在这一层，不再改 main.tsx；
 * - 包住 StrictMode，让入口文件保持只做"找到 #root 并渲染"这一件事。
 *
 * 默认主题为 Claude（见 stores/theme-store.ts 的 getInitialTheme），
 * 用户在设置面板的选择仍存 localStorage("inno.theme")，优先于默认值。
 */
export function PageContainer({ children }: { children: ReactNode }) {
	const theme = useStoreSnapshot(themeStore, () => themeStore.current);
	const [claudeMode, setClaudeMode] = useState<ClaudeViewMode>(() => readClaudeViewMode());

	useEffect(() => {
		void settingsStore.load();
		const unsubscribe = settingsStore.on("change", () => {
			const remote = settingsStore.settings?.ui?.theme as ThemeId | undefined;
			if (remote && remote !== themeStore.current) {
				themeStore.apply(remote);
			}
		});
		return unsubscribe;
	}, []);

	const switchClaudeMode = useCallback((mode: ClaudeViewMode) => {
		setClaudeMode(mode);
		localStorage.setItem(CLAUDE_VIEW_MODE_KEY, mode);
	}, []);

	return (
		<StrictMode>
			<div
				className="page-container"
				style={{ minHeight: "100vh", background: "var(--inno-background)", color: "var(--inno-text)" }}
			>
				{theme === "claude" && claudeMode === "arena" ? (
					<ClaudeArenaApp onSwitchChat={() => switchClaudeMode("chat")} />
				) : (
					<>
						{theme === "claude" ? (
							<div className="fixed right-4 top-3 z-50 inline-flex rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface-muted)] p-0.5 shadow-[var(--inno-shadow-soft)]">
								<button
									type="button"
									className="inline-flex items-center gap-1 rounded bg-[var(--inno-surface)] px-2 py-1 text-xs font-medium text-[var(--inno-accent)] shadow-sm"
								>
									<MessageSquare size={13} />
									Chat
								</button>
								<button
									type="button"
									className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--inno-text-muted)] hover:text-[var(--inno-accent)]"
									onClick={() => switchClaudeMode("arena")}
								>
									<Swords size={13} />
									Arena
								</button>
							</div>
						) : null}
						{children}
					</>
				)}
			</div>
		</StrictMode>
	);
}
